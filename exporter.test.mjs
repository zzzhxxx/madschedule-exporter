// Structural regression tests for the MadSchedule Exporter userscript.
// Runs the pure DOM-free CORE (extracted from mad-schedule-exporter.user.js)
// end-to-end: extract -> normalize -> build -> validate. All course IDs,
// subjects, titles, rooms and exam dates are invented; this is not a captured
// student schedule. No student identity or authentication data is produced.
import { readFileSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const script = readFileSync(new URL('./mad-schedule-exporter.user.js', import.meta.url), 'utf8');
const begin = script.indexOf('/*::CORE-BEGIN::*/');
const end = script.indexOf('/*::CORE-END::*/');
assert.ok(begin !== -1 && end !== -1, 'CORE markers missing from userscript');
const CORE = new Function(`${script.slice(begin + '/*::CORE-BEGIN::*/'.length, end)}\nreturn CORE;`)();

// Observed UW field shape. Structural fixture only.
function sample() {
  const meeting = {exam:false, online:false, meetingOrExamNumber:'1', location:'Synthetic Room', dayInitials:'TR', start:'2023-01-03T14:30:00-06:00', end:'2023-01-03T15:45:00-06:00', footnotes:[]};
  const exam = {exam:true, online:false, meetingOrExamNumber:'1', location:'Location not specified', dayInitials:null, start:'2026-12-18T07:45:00-06:00', end:'2026-12-18T09:45:00-06:00', footnotes:[]};
  const classes = [
    {id:'synthetic-lecture', type:'LEC', sectionNumber:'001', meetings:[meeting], exams:[exam]},
    {id:'synthetic-lab', type:'LAB', sectionNumber:'301', meetings:[{...meeting, online:true, location:'ONLINE', dayInitials:null, start:null, end:null}], exams:[]},
  ];
  const course = {id:'synthetic-course', catalogNumber:'123', subject:'SYNTHETIC SUBJECT', subjectShortDesc:'SYNTH', subjectCode:'000', title:'Structural Test Course', color:'#000000', exams:[exam]};
  return {netId:'DO-NOT-EXPORT', termCode:'1272', terms:{present:{name:'Fall 2026', code:'1272'}, available:[{name:'Fall 2026', code:'1272'}]}, timeRange:{earliest:'09:00:00', latest:'18:00:00'}, events:[], courses:[course], classes, courseForClassId:Object.fromEntries(classes.map(c=>[c.id, course])), classesForCourseId:{[course.id]:classes}};
}

function documentFor(d, options = {}) {
  const regions = d.courses.map(c => ({
    querySelector: () => ({ textContent: `${c.subjectShortDesc} ${c.catalogNumber}: ${c.title}` }),
    querySelectorAll: q => q === ':scope > strong'
      ? ['Weekly Meetings', 'Exams'].filter(x => !options.noExams || x !== 'Exams').map(textContent => ({ textContent, nextElementSibling: textContent === 'Exams' ? { tagName:'UL', querySelectorAll: () => d.courses.find(x => x.id === c.id).exams.map(e => ({ textContent: `${e.location} ${e.meetingOrExamNumber}` })) } : null }))
      : d.classesForCourseId[c.id].flatMap(cc => cc.meetings.map(() => ({ id: cc.id, textContent: `${cc.type} ${cc.sectionNumber}` }))),
  }));
  return {
    scripts: [{ src:'', type:'module', textContent: `const data = ${JSON.stringify(d)};` }],
    querySelector: () => ({ selectedOptions: [{ value: options.term || d.termCode, text:'Fall 2026' }] }),
    querySelectorAll: () => regions.slice(options.missingRegion ? 1 : 0),
  };
}

// Deterministic context so IDs are reproducible within the test run.
function contextFor(raw) {
  return {
    dataSpaceID: 'test-space',
    scopeID: 'test-scope',
    extractedAt: '2026-09-09T12:00:00Z',
    expectedEvidence: 'livePage',
    expectedTermKey: raw.termKey,
  };
}

async function exportDoc(d) {
  const raw = CORE.extractUWRawSchedule(documentFor(d));
  const snapshot = await CORE.normalizeUWSchedule(raw, contextFor(raw));
  const doc = CORE.buildMadScheduleExport(snapshot);
  CORE.validateExport(doc);
  return { raw, snapshot, doc };
}

test('identity vectors match the frozen UTF-8 length-prefixed SHA-256', async () => {
  const vectors = JSON.parse(readFileSync(new URL('./contracts/examples/identity-v1.json', import.meta.url), 'utf8'));
  for (const v of vectors) {
    assert.equal(await CORE.stableIdentity(v.parts), v.id);
  }
});

test('page detection accepts only the exact Course Schedule URL', () => {
  assert.equal(CORE.detectCourseSchedulePage({ protocol:'https:', host:'mumaaenroll.services.wisc.edu', pathname:'/courses-schedule' }), true);
  assert.equal(CORE.detectCourseSchedulePage({ protocol:'https:', host:'mumaaenroll.services.wisc.edu', pathname:'/courses-schedule/' }), true);
  assert.equal(CORE.detectCourseSchedulePage({ protocol:'https:', host:'mumaaenroll.services.wisc.edu', pathname:'/other' }), false);
  assert.equal(CORE.detectCourseSchedulePage({ protocol:'http:', host:'mumaaenroll.services.wisc.edu', pathname:'/courses-schedule' }), false);
  assert.equal(CORE.detectCourseSchedulePage({ protocol:'https:', host:'evil.example', pathname:'/courses-schedule' }), false);
});

test('full pipeline groups LEC/LAB, preserves weekly + async online, real exam date, no identity', async () => {
  const { raw, snapshot, doc } = await exportDoc(sample());
  assert.equal(raw.termKey, '1272');
  assert.equal(raw.termName, 'Fall 2026');
  assert.equal(snapshot.courses.length, 1);
  const course = snapshot.courses[0];
  assert.equal(course.subject, 'SYNTH');
  assert.equal(course.catalogNumber, '123');
  assert.equal(course.components.length, 2);
  const lec = course.components.find(c => c.type === 'LEC');
  const lab = course.components.find(c => c.type === 'LAB');
  assert.equal(lec.session.value, 'LEC 001');
  assert.equal(lab.session.value, 'LAB 301');
  assert.deepEqual(lec.meetings[0].weekdays.value, ['tue', 'thu']);
  assert.deepEqual(lec.meetings[0].time.value, { start:'14:30', end:'15:45', endDayOffset:0 });
  assert.equal(lec.meetings[0].kind, 'weekly');
  assert.equal(lec.meetings[0].deliveryMode.value, 'inPerson');
  assert.equal(lec.meetings[0].dateRange.state, 'notProvided');
  assert.equal(lab.meetings[0].deliveryMode.value, 'online');
  assert.equal(lab.meetings[0].kind, 'unscheduled');
  assert.equal(lab.meetings[0].onlineMode, 'asynchronous');
  assert.equal(lab.meetings[0].time.state, 'notApplicable');
  assert.equal(course.exams.value.length, 1);
  const exam = course.exams.value[0];
  assert.equal(exam.date.value, '2026-12-18');
  assert.equal(exam.location.state, 'notProvided');
  assert.deepEqual(exam.componentIDs, [lec.id]);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.revision, 1);
  assert.equal(doc.dataSpaceID, 'test-space');
  assert.equal(doc.snapshots.length, 1);
  assert.equal(doc.snapshots[0].source.type, 'scriptJSON');
  // No identity, no 2023 display-anchor dates, no netId leak into the document.
  const json = JSON.stringify(doc);
  assert.ok(!json.includes('DO-NOT-EXPORT'));
  assert.ok(!json.includes('netId'));
  assert.ok(!json.includes('2023-01'));
  assert.ok(!json.includes('Synthetic Room') === false); // location IS business data and is preserved
});

test('term transition, missing region, missing exams, unknown field, broken association, changed anchor, empty classes all fail closed', async () => {
  const cases = [
    ['term transition', d => {}, { term:'1264' }],
    ['missing region', d => {}, { missingRegion:true }],
    ['missing exams region', d => {}, { noExams:true }],
    ['unknown field', d => { d.classes[0].session = 'NEW'; }],
    ['broken association', d => { delete d.courseForClassId['synthetic-lecture']; }],
    ['changed weekly anchor', d => { d.classes[0].meetings[0].start = '2026-09-01T14:30:00-05:00'; }],
    ['empty class list (0 courses despite page)', d => { d.classes = []; d.classesForCourseId = {}; d.courseForClassId = {}; }],
  ];
  for (const [label, mutate, options] of cases) {
    const d = sample();
    mutate(d);
    await assert.rejects(async () => {
      const raw = CORE.extractUWRawSchedule(documentFor(d, options));
      await CORE.normalizeUWSchedule(raw, contextFor(raw));
    }, err => err instanceof CORE.UWParserError || err instanceof CORE.ExportValidationError, label);
  }
});

test('ONLINE marker wins and null location defaults to inPerson', async () => {
  const d = sample();
  d.classes[0].meetings[0].location = 'ONLINE';
  let { snapshot } = await exportDoc(d);
  assert.equal(snapshot.courses[0].components[0].meetings[0].deliveryMode.value, 'online');
  d.classes[0].meetings[0].location = null;
  ({ snapshot } = await exportDoc(d));
  assert.equal(snapshot.courses[0].components[0].meetings[0].deliveryMode.value, 'inPerson');
});

test('an updated exam location does not break course/component association', async () => {
  const d = JSON.parse(JSON.stringify(sample()));
  d.courses[0].exams[0].location = 'Updated Exam Hall';
  const { snapshot } = await exportDoc(d);
  assert.equal(snapshot.courses[0].exams.value[0].location.value, 'Updated Exam Hall');
});

test('visible exam copy is authoritative while a scheduled time conflict fails', async () => {
  const locationConflict = JSON.parse(JSON.stringify(sample()));
  locationConflict.courses[0].exams[0].location = 'Hall A';
  locationConflict.classes[0].exams[0].location = 'Hall B';
  await assert.doesNotReject(() => exportDoc(locationConflict));

  const timeConflict = JSON.parse(JSON.stringify(sample()));
  timeConflict.courses[0].exams[0].start = '2026-12-18T08:45:00-06:00';
  await assert.rejects(() => exportDoc(timeConflict), err => err instanceof CORE.UWParserError || err instanceof CORE.ExportValidationError);
});

test('empty exam arrays do not invent an official not-published announcement', async () => {
  const d = sample();
  d.classes.forEach(c => { c.exams = []; });
  d.courses[0].exams = [];
  const { snapshot } = await exportDoc(d);
  assert.ok(snapshot.courses[0].components.every(c => c.exams === undefined)); // component rows carry no exam field
  assert.equal(snapshot.courses[0].exams.state, 'notProvided');
});

test('multiple meetings and midnight exams are preserved with explicit endDayOffset', async () => {
  const d = sample();
  const c = d.classes[0];
  c.meetings.push({ ...c.meetings[0], meetingOrExamNumber:'2', dayInitials:'F', start:'2023-01-06T11:00:00-06:00', end:'2023-01-06T12:00:00-06:00' });
  c.exams[0].start = '2026-12-18T23:00:00-06:00';
  c.exams[0].end = '2026-12-19T01:00:00-06:00';
  const { snapshot } = await exportDoc(d);
  assert.equal(snapshot.courses[0].components[0].meetings.length, 2);
  assert.equal(snapshot.courses[0].exams.value[0].time.value.endDayOffset, 1);
});

test('Spring HTML shape: course overview is a subset of numbered component exam rooms', async () => {
  const d = JSON.parse(JSON.stringify(sample()));
  const exams = Array.from({ length:4 }, (_, i) => ({ ...d.classes[0].exams[0], meetingOrExamNumber:String(i + 1), location:`Synthetic Hall ${i + 1}` }));
  d.classes[0].exams = structuredClone(exams);
  d.classesForCourseId[d.courses[0].id][0].exams = structuredClone(exams);
  d.courses[0].exams = [structuredClone(exams[0])];
  Object.values(d.courseForClassId).forEach(c => { c.exams = [structuredClone(exams[0])]; });
  let { snapshot } = await exportDoc(d);
  assert.equal(snapshot.courses[0].exams.value.length, 1);
  assert.equal(snapshot.courses[0].exams.value[0].location.value, exams[0].location);

  d.courses[0].exams[0].meetingOrExamNumber = '99';
  await assert.rejects(() => exportDoc(d), err => err instanceof CORE.UWParserError || err instanceof CORE.ExportValidationError);
});

test('validator rejects unsupported schemaVersion, missing top-level fields, and non-confirmed empty courses', async () => {
  const { snapshot, doc } = await exportDoc(sample());

  const badVersion = JSON.parse(JSON.stringify(doc));
  badVersion.schemaVersion = 2;
  assert.throws(() => CORE.validateExport(badVersion), CORE.ExportValidationError);

  const missingField = JSON.parse(JSON.stringify(doc));
  delete missingField.dataSpaceID;
  assert.throws(() => CORE.validateExport(missingField), CORE.ExportValidationError);

  const emptyCourses = JSON.parse(JSON.stringify(snapshot));
  emptyCourses.courses = [];
  emptyCourses.confirmedEmpty = false;
  assert.throws(() => CORE.validateSnapshot(emptyCourses), CORE.ExportValidationError);
});

test('filename slug is lowercase, hyphenated, and prefixed with mad-schedule-', () => {
  assert.equal(CORE.buildFilename('Fall 2026', '1272'), 'mad-schedule-fall-2026.json');
  assert.equal(CORE.buildFilename('  Summer 2026  ', '1266'), 'mad-schedule-summer-2026.json');
  assert.equal(CORE.buildFilename('', '1272'), 'mad-schedule-1272.json');
});

test('isOlderTerm compares against the latest available term, not a hardcoded year', () => {
  assert.equal(CORE.latestTermCode([{ code: '1264', name: 'Spring 2026' }, { code: '1272', name: 'Fall 2026' }]), 1272);
  assert.equal(CORE.latestTermCode([{ code: '1278', name: 'Fall 2027' }, { code: '1272', name: 'Fall 2026' }]), 1278);
  assert.equal(CORE.latestTermCode([]), null);
  assert.equal(CORE.latestTermCode(null), null);
  assert.equal(CORE.latestTermCode([{ code: 'abc' }]), null);

  assert.equal(CORE.isOlderTerm('1264', 1272), true);
  assert.equal(CORE.isOlderTerm('1266', 1272), true);
  assert.equal(CORE.isOlderTerm('1272', 1272), false);
  assert.equal(CORE.isOlderTerm('1274', 1272), false);
  assert.equal(CORE.isOlderTerm(null, 1272), false);
  assert.equal(CORE.isOlderTerm('1264', null), false);
  assert.equal(CORE.isOlderTerm('abc', 1272), false);
});

test('extraction exposes the latest available term for the advisory gate', () => {
  const raw = CORE.extractUWRawSchedule(documentFor(sample()));
  assert.equal(raw.latestTermKey, '1272');
  assert.equal(raw.latestTermName, 'Fall 2026');
});

test('serialization is UTF-8 2-space-indented JSON', async () => {
  const { doc } = await exportDoc(sample());
  const json = CORE.serializeExport(doc);
  assert.ok(json.includes('\n  "schemaVersion": 1'));
  assert.equal(JSON.parse(json).schemaVersion, 1);
});

// Optional cross-language fixture; all visible data is invented above.
test('official exporter output interoperates with the Swift JSON importer', async () => {
  const { doc } = await exportDoc(sample());
  assert.equal(doc.snapshots[0].source.type, 'scriptJSON');
  if (process.env.MADSCHEDULE_EXPORT_TEST_OUTPUT) {
    doc.snapshots[0].source.evidence = 'syntheticFixture';
    writeFileSync(process.env.MADSCHEDULE_EXPORT_TEST_OUTPUT, JSON.stringify(doc, null, 2) + '\n');
  }
});

test('exporter validation rejects UW or manual provenance', async () => {
  for (const type of ['uwWeb', 'manual']) {
    const { doc } = await exportDoc(sample());
    doc.snapshots[0].source.type = type;
    assert.throws(() => CORE.validateExport(doc), CORE.ExportValidationError);
  }
});
