// ==UserScript==
// @name         MadSchedule Exporter
// @name:zh-CN   MadSchedule 课表导出助手
// @namespace    mad-schedule
// @version      1.0.1
// @description  Export the currently displayed UW–Madison Course Schedule to a json file that can be used in MadSchedule.
// @description:zh-CN 将 UW–Madison 官方页面当前显示的课表导出为可在MadSchedule中导入的JSON文件。
// @author       MadSchedule
// @license      MIT
// @homepageURL  https://github.com/zzzhxxx/madschedule-exporter
// @supportURL   https://github.com/zzzhxxx/madschedule-exporter/issues
// @updateURL    https://raw.githubusercontent.com/zzzhxxx/madschedule-exporter/main/mad-schedule-exporter.user.js
// @downloadURL  https://raw.githubusercontent.com/zzzhxxx/madschedule-exporter/main/mad-schedule-exporter.user.js
// @match        https://mumaaenroll.services.wisc.edu/courses-schedule
// @match        https://mumaaenroll.services.wisc.edu/courses-schedule/
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

/*
 * MadSchedule Exporter — manual / fallback export path.
 *
 * Reads the student's already-authenticated UW Course Schedule page, extracts
 * the official schedule data, and emits the frozen MadSchedule JSON v1
 * document (contracts/schedule-v1.schema.json). It does NOT log in, does NOT
 * fetch anything over the network, and does NOT persist or transmit anything.
 *
 * The JSON contract is the source of truth. The extraction/normalisation logic
 * below deliberately mirrors the production iOS pipeline so the emitted IDs,
 * field states and issues match what the app itself would produce:
 *
 *   UW page
 *     -> extractUWRawSchedule()   (mirrors Resources/WebExtraction/inspect-schedule.js)
 *     -> normalizeUWSchedule()    (mirrors Domain/ScheduleNormalizer + StableIdentity)
 *     -> buildMadScheduleExport() (mirrors UserScheduleData shape)
 *     -> validateExport()         (mirrors Domain/ScheduleValidator)
 *     -> downloadJSON()
 *
 * The pure, DOM-free core (between the CORE-BEGIN / CORE-END markers) is
 * extracted and exercised by exporter.test.mjs under Node.
 */

(function () {
  'use strict';

  /*::CORE-BEGIN::*/
  // ---------------------------------------------------------------------------
  // Pure, DOM-free core. No document / window / location / Blob / URL / GM_*.
  // Only Date, JSON, Object, Array, Set, Map, TextEncoder and globalThis.crypto.
  // ---------------------------------------------------------------------------

  const DEBUG = false;

  const SCHEMA_VERSION = 1;
  const TIME_ZONE = 'America/Chicago';
  const PARSER_VERSION = 'uw-course-schedule-2026-09-09.4';
  const PAGE_IDENTIFIER = 'uw-course-schedule';
  const MAX_REVISION = 9007199254740991;

  const meetingKeys = ['exam', 'online', 'meetingOrExamNumber', 'location', 'dayInitials', 'start', 'end', 'footnotes'];

  // UW term codes are monotonic integers (1264 Spring 2026 < 1266 Summer 2026 <
  // 1272 Fall 2026 < 1274 Spring 2027 …). "Latest term" is the highest code among
  // the selectable terms, not a hardcoded year — so the advisory boundary follows
  // whatever term is current on the schedule page.
  function latestTermCode(available) {
    if (!Array.isArray(available)) return null;
    let best = null;
    for (const t of available) {
      if (!t || !/^\d+$/.test(String(t.code))) continue;
      const code = parseInt(t.code, 10);
      if (best == null || code > best) best = code;
    }
    return best;
  }

  // True when `code` sorts strictly before `latestCode`. Gates only the advisory
  // "older term" confirmation — never extraction or validation.
  function isOlderTerm(code, latestCode) {
    const a = /^\d+$/.test(String(code)) ? parseInt(code, 10) : null;
    const b = /^\d+$/.test(String(latestCode)) ? parseInt(latestCode, 10) : null;
    return a != null && b != null && a < b;
  }

  class UWParserError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'UWParserError';
      this.code = code || 'parseError';
    }
  }

  class ExportValidationError extends Error {
    constructor(message) {
      super(message);
      this.name = 'ExportValidationError';
    }
  }

  // --- small assertion helpers -------------------------------------------------

  function fail(message, code) { throw new UWParserError(message, code); }
  function require(condition, message, code) { if (!condition) fail(message, code); }
  function assert(condition, message) { if (!condition) throw new ExportValidationError(message); }

  const text = value => typeof value === 'string' && value.trim().length > 0;

  function utf8Length(value) { return new TextEncoder().encode(value).length; }

  function assertNonempty(values) {
    assert(values.every(v => typeof v === 'string' && v.trim().length > 0 && utf8Length(v) <= 4096),
      '必需文本为空或超限');
  }

  function assertUnique(values) { assert(new Set(values).size === values.length, '重复记录 ID'); }

  function unique(values) {
    require(new Set(values).size === values.length, '重复来源标识', 'schemaMismatch');
  }

  // Mirrors the adapter's strict key check: no unmapped keys, no missing keys.
  function keys(value, allowed, code) {
    require(value && typeof value === 'object' && !Array.isArray(value), '字段不是对象', code);
    require(Object.keys(value).every(k => allowed.includes(k)), '出现未经映射的新字段', code);
    require(allowed.every(k => Object.prototype.hasOwnProperty.call(value, k)), '必要字段缺失', code);
  }

  // --- SourceField constructors (mirror ScheduleModels.SourceField) -----------

  const known = value => ({ state: 'known', value });
  const missing = sourceText => ({ state: 'notProvided', ...(sourceText ? { sourceText } : {}) });
  const na = () => ({ state: 'notApplicable' });

  // --- stable identity (mirrors Domain/StableIdentity) ------------------------

  async function sha256Hex(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  async function stableIdentity(parts) {
    const canonical = parts.map(p => `${utf8Length(p)}:${p}`).join('');
    return 'v1-' + await sha256Hex(canonical);
  }

  function randomUUID() {
    const crypto = globalThis.crypto;
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // --- date / time validation (mirrors ScheduleValidator) ---------------------

  function isValidDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }

  function isValidTime(value) { return /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value); }

  function isValidInstant(value) {
    if (typeof value !== 'string') return false;
    const m = value.match(/^(\d{4}-\d{2}-\d{2})T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$/);
    return !!m && isValidDate(m[1]);
  }

  function validateTimeRange(time) {
    assert(isValidTime(time.start) && isValidTime(time.end), '时间必须为 HH:mm');
    assert(Number.isInteger(time.endDayOffset) && time.endDayOffset >= 0 && time.endDayOffset <= 1, '无效跨日偏移');
    assert(time.endDayOffset === 1 || time.end > time.start, '结束时间必须晚于开始时间；跨日须明确');
  }

  // --- field / snapshot validation (mirrors ScheduleValidator.validate) -------

  function validateField(field, path) {
    assert(field.state !== 'parseFailed', `${path}：页面字段解析失败`);
    const isKnown = field.state === 'known';
    assert(isKnown === (field.value != null), `${path}：字段状态和值不一致`);
    if (typeof field.value === 'string') assertNonempty([field.value]);
    if (field.sourceText != null) assert(utf8Length(field.sourceText) <= 4096, '来源文本过长');
  }

  function validateSnapshot(snapshot) {
    assert(snapshot.schemaVersion === SCHEMA_VERSION, '不支持的 schemaVersion');
    assert(snapshot.source.type === 'scriptJSON', '导出来源必须为 scriptJSON');
    assert(snapshot.timeZone === TIME_ZONE, '校园时区无效');
    assert(snapshot.complete === true, '读取范围不完整，拒绝替换');
    assert(snapshot.courses.length > 0 || snapshot.confirmedEmpty === true, '没有经确认的官方空课表状态');
    assert(snapshot.confirmedEmpty !== true || snapshot.courses.length === 0, '空课表声明与课程冲突');
    assert(snapshot.courses.length <= 500, '课程数量超出限制');
    assertNonempty([snapshot.id, snapshot.dataSpaceID, snapshot.term.id, snapshot.term.name,
    snapshot.source.scopeID, snapshot.source.parserVersion, snapshot.source.pageIdentifier]);
    assert(isValidInstant(snapshot.source.extractedAt), '提取时间必须是 RFC 3339 时间点');
    assertUnique(snapshot.courses.map(c => c.id));
    assert(snapshot.issues.length <= 10000, '字段提示数量超限');
    for (const issue of snapshot.issues) assertNonempty([issue.path, issue.message]);

    let issues = snapshot.issues.filter(issue =>
      !(snapshot.source.type === 'uwWeb' && issue.path.endsWith('.dateRange') && issue.message === '页面未提供'));

    function field(f, path, reportMissing) {
      validateField(f, path);
      if (reportMissing !== false && f.state === 'notProvided') issues.push({ path, message: '页面未提供' });
    }

    field(snapshot.term.officialID, 'term.officialID');

    for (const course of snapshot.courses) {
      assertNonempty([course.id, course.subject, course.catalogNumber, course.title]);
      assert(course.termID === snapshot.term.id, '课程归属学期不匹配');
      assert(course.components.length > 0 && course.components.length <= 100, '课程 component 区域缺失或超限');
      field(course.association, `${course.id}.association`);
      assertUnique(course.components.map(c => c.id));
      for (const component of course.components) {
        const p = `${course.subject} ${course.catalogNumber}.${component.type} ${component.section}`;
        assertNonempty([component.id, component.type, component.section]);
        field(component.officialID, `${p}.officialID`);
        field(component.session, `${p}.session`);
        assert(component.meetings.length > 0 && component.meetings.length <= 500, `${p}：meeting 区域缺失或超限`);
        assertUnique(component.meetings.map(m => m.id));
        for (const m of component.meetings) {
          assertNonempty([m.id]);
          field(m.weekdays, `${p}.weekdays`); field(m.dates, `${p}.dates`); field(m.time, `${p}.time`);
          field(m.dateRange, `${p}.dateRange`, snapshot.source.type !== 'uwWeb');
          field(m.location, `${p}.location`); field(m.deliveryMode, `${p}.deliveryMode`);
          if (m.weekdays.value) {
            assert(m.weekdays.value.length > 0 && new Set(m.weekdays.value).size === m.weekdays.value.length, '星期为空或重复');
          }
          if (m.dates.value) {
            assert(m.dates.value.length > 0 && new Set(m.dates.value).size === m.dates.value.length && m.dates.value.every(isValidDate), '日期无效或重复');
          }
          if (m.dateRange.value) {
            assert(isValidDate(m.dateRange.value.start) && isValidDate(m.dateRange.value.endInclusive) &&
              m.dateRange.value.start <= m.dateRange.value.endInclusive, '日期范围无效');
          }
          if (m.time.value) validateTimeRange(m.time.value);
          if (m.onlineMode) {
            assert(m.deliveryMode.value === 'online', '在线模式与授课方式冲突');
            if (m.onlineMode === 'asynchronous') {
              assert(m.kind === 'unscheduled' && m.time.state === 'notApplicable' && m.weekdays.state === 'notApplicable' &&
                m.dates.state === 'notApplicable' && m.dateRange.state === 'notApplicable', '异步课程不应包含日期时间');
            } else {
              assert(m.time.state === 'known', '在线直播课程缺少排定时间');
            }
          }
          switch (m.kind) {
            case 'weekly':
              assert(m.weekdays.state === 'known' && m.dates.state === 'notApplicable', '重复课的星期或日期语义冲突'); break;
            case 'specificDates':
              assert(m.dates.state === 'known' && m.weekdays.state === 'notApplicable', '明确日期不能伪装成周重复'); break;
            case 'unscheduled':
              assert(m.time.state !== 'known' && m.weekdays.value == null && m.dates.value == null, '未定时课程含有定时安排'); break;
            default:
              assert(false, '未知 meeting kind');
          }
        }
      }
      field(course.exams, `${course.id}.exams`);
      if (course.exams.value) {
        assert(course.exams.value.length <= 500, '考试数量超限');
        assertUnique(course.exams.value.map(e => e.id));
        for (const exam of course.exams.value) {
          assertNonempty([exam.id]);
          assertUnique(exam.componentIDs);
          assert(exam.componentIDs.every(cid => course.components.some(c => c.id === cid)), '考试 component 关联无效');
          field(exam.date, 'exam.date'); field(exam.time, 'exam.time'); field(exam.location, 'exam.location');
          if (exam.date.value) assert(isValidDate(exam.date.value), '考试日期无效');
          if (exam.time.value) validateTimeRange(exam.time.value);
        }
      }
    }

    const seen = new Set();
    const result = issues.filter(issue => {
      const key = issue.path + ' ' + issue.message;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    assert(result.length <= 10000, '字段提示数量超限');
    return result;
  }

  function validateExport(doc) {
    assert(doc.schemaVersion === SCHEMA_VERSION &&
      Number.isInteger(doc.revision) && doc.revision >= 0 && doc.revision <= MAX_REVISION, '存储版本或 revision 不受支持');
    assert(doc.snapshots.length <= 40, '学期快照数量超限');
    assertNonempty([doc.dataSpaceID]);
    assertUnique(doc.snapshots.map(s => `${s.term.id} ${s.source.type} ${s.source.scopeID}`));
    assertUnique(doc.snapshots.map(s => s.id));
    assertUnique(doc.snapshots.flatMap(s => s.courses.map(c => c.id)));
    assertUnique(doc.snapshots.flatMap(s => s.courses.flatMap(c => c.components.map(cp => cp.id))));
    assertUnique(doc.snapshots.flatMap(s => s.courses.flatMap(c => c.components.flatMap(cp => cp.meetings.map(m => m.id)))));
    assertUnique(doc.snapshots.flatMap(s => s.courses.flatMap(c => (c.exams.value || []).map(e => e.id))));
    for (const s of doc.snapshots) {
      assert(s.dataSpaceID === doc.dataSpaceID, '数据空间不一致');
      validateSnapshot(s);
    }
  }

  // --- page detection ----------------------------------------------------------

  function detectCourseSchedulePage(loc) {
    const l = loc || (typeof location !== 'undefined' ? location : null);
    if (!l || !l.host) return false;
    return l.protocol === 'https:' && l.host === 'mumaaenroll.services.wisc.edu' &&
      (l.pathname === '/courses-schedule' || l.pathname === '/courses-schedule/');
  }

  // --- UW raw extraction (mirrors inspect-schedule.js) ------------------------

  const dateTime = value => {
    require(typeof value === 'string', '日期时间类型错误', 'unrecognizedMeetingFormat');
    const m = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):00(-0[56]:00)$/);
    require(m, '日期时间格式或时区未经核验', 'unrecognizedMeetingFormat');
    return { date: m[1], time: m[2] };
  };

  const range = (start, end) => {
    const a = dateTime(start), b = dateTime(end);
    const offset = (Date.parse(b.date + 'T00:00:00Z') - Date.parse(a.date + 'T00:00:00Z')) / 86400000;
    require(offset === 0 || offset === 1, '时间跨日范围未知', 'unrecognizedMeetingFormat');
    return known({ start: a.time, end: b.time, endDayOffset: offset });
  };

  // Canonical form used only to cross-check the class/course mapping. Exam
  // location is mutable display data and is deliberately excluded.
  const canonical = value => JSON.stringify(value, (key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().filter(k => !(v.exam === true && k === 'location')).map(k => [k, v[k]]));
    }
    return v;
  });
  const same = (a, b) => canonical(a) === canonical(b);

  function parseLocation(value) {
    require(value === null || typeof value === 'string', '地点类型错误', 'unrecognizedMeetingFormat');
    if (!value || value === 'Location not specified') return missing(value);
    if (/^TBA$/i.test(value)) return { state: 'tba', sourceText: value };
    if (/^arranged$/i.test(value)) return { state: 'arranged', sourceText: value };
    return known(value);
  }

  function parseMeetings(c) {
    return c.meetings.map(m => {
      keys(m, meetingKeys, 'unrecognizedCourseStructure');
      require(m.exam === false && typeof m.online === 'boolean' && text(m.meetingOrExamNumber), 'meeting 类型未知', 'unrecognizedMeetingFormat');
      const online = m.online || /\bONLINE\b/i.test(m.location || '');
      const base = { id: m.meetingOrExamNumber, dates: na(), dateRange: missing(), location: parseLocation(m.location), deliveryMode: known(online ? 'online' : 'inPerson') };
      if (online && m.start === null && m.end === null) {
        return { ...base, onlineMode: 'asynchronous', kind: 'unscheduled', weekdays: na(), dates: na(), time: na(), dateRange: na() };
      }
      if (online) base.onlineMode = 'synchronous';
      if (m.start === null && m.end === null && m.dayInitials === null) {
        return { ...base, kind: 'unscheduled', weekdays: missing(), time: missing() };
      }
      require(text(m.dayInitials) && /^[MTWRFSU]+$/.test(m.dayInitials), '星期格式未知', 'unrecognizedMeetingFormat');
      const dayMap = { M: 'mon', T: 'tue', W: 'wed', R: 'thu', F: 'fri', S: 'sat', U: 'sun' };
      const days = [...m.dayInitials].map(d => dayMap[d]);
      unique(days);
      // Current UW calendar uses January 2023 as its weekly display anchor.
      const anchor = dateTime(m.start).date;
      require(/^2023-01-0[1-7]$/.test(anchor), '每周时间占位日期已变化，需要复核', 'unrecognizedMeetingFormat');
      return { ...base, kind: 'weekly', weekdays: known(days), time: range(m.start, m.end) };
    });
  }

  function parseExams(c, course, sameExam) {
    // Only the student's visible course exam list is authoritative. Component
    // records may contain additional rooms not displayed to this user.
    const exams = course.exams.filter(e => c.exams.some(x => sameExam(e, x))).map(e => {
      keys(e, meetingKeys, 'unrecognizedCourseStructure');
      require(e.exam === true && text(e.meetingOrExamNumber) && e.dayInitials === null, '考试结构未知', 'unrecognizedMeetingFormat');
      const absent = e.start === null && e.end === null;
      return {
        id: `course:${e.meetingOrExamNumber}:${e.start ?? 'unknown'}:${e.end ?? 'unknown'}`,
        componentIDs: [],
        date: absent ? missing() : known(dateTime(e.start).date),
        time: absent ? missing() : range(e.start, e.end),
        location: parseLocation(e.location),
      };
    });
    return course.exams.length ? known(exams) : missing('No exam entries in visible page');
  }

  function parseComponent(c, course, data, visibleComponents, sameExam) {
    keys(c, ['id', 'type', 'sectionNumber', 'meetings', 'exams'], 'unrecognizedCourseStructure');
    require([c.id, c.type, c.sectionNumber].every(text), '组件标识缺失', 'unrecognizedCourseStructure');
    require(same(data.classes.find(x => x.id === c.id), c) && same(data.courseForClassId[c.id], course), '课程与组件关联冲突', 'schemaMismatch');
    require(Array.isArray(c.meetings) && c.meetings.length > 0 && Array.isArray(c.exams), 'meeting 或考试字段缺失', 'unrecognizedCourseStructure');
    require(visibleComponents.filter(x => x.id === c.id && x.textContent.trim() === `${c.type} ${c.sectionNumber}`).length === c.meetings.length, '组件未完整显示', 'pageMismatch');
    unique(c.meetings.map(m => m.meetingOrExamNumber));
    unique(c.exams.map(e => e.meetingOrExamNumber));
    return {
      rowKey: c.id,
      termKey: data.termCode,
      subject: course.subjectShortDesc,
      catalogNumber: course.catalogNumber,
      title: course.title,
      enrollmentKey: course.id,
      componentKey: c.id,
      officialComponentID: known(c.id),
      type: c.type,
      section: c.sectionNumber,
      session: known(`${c.type} ${c.sectionNumber}`),
      meetings: parseMeetings(c),
      exams: parseExams(c, course, sameExam),
    };
  }

  function parseTerm(data, document) {
    const selected = document.querySelector('#term-code')?.selectedOptions;
    require(selected?.length === 1 && text(data.termCode), '学期未就绪', 'termNotFound');
    require(selected[0].value === data.termCode, '学期切换尚未完成', 'termNotFound');
    const term = data.terms?.available?.find(t => t.code === data.termCode);
    require(term && term.name === selected[0].text.trim(), '学期名称不一致', 'termNotFound');
    return term;
  }

  function parseCourses(data, document, regions) {
    const rows = [];
    for (const course of data.courses) {
      keys(course, ['id', 'catalogNumber', 'subject', 'subjectShortDesc', 'subjectCode', 'title', 'color', 'exams'], 'unrecognizedCourseStructure');
      require([course.id, course.catalogNumber, course.subjectShortDesc, course.title].every(text), '课程标识缺失', 'unrecognizedCourseStructure');
      const components = data.classesForCourseId[course.id];
      require(Array.isArray(components) && components.length > 0 && Array.isArray(course.exams), '组件或考试区域缺失', 'unrecognizedCourseStructure');
      unique(components.map(c => c.id));
      const heading = `${course.subjectShortDesc} ${course.catalogNumber}: ${course.title}`;
      const matchedRegions = regions.filter(r => r.querySelector('strong.fs-3')?.textContent.trim() === heading);
      require(matchedRegions.length === 1, '课程标题无法与可见区域对应', 'pageMismatch');
      const region = matchedRegions[0];
      const headingNodes = [...region.querySelectorAll(':scope > strong')];
      const headings = headingNodes.map(x => x.textContent.trim());
      require(headings.includes('Weekly Meetings') && headings.includes('Exams'), '每周课表或考试区域未就绪', 'pageMismatch');
      const examList = headingNodes.find(x => x.textContent.trim() === 'Exams').nextElementSibling;
      require(examList?.tagName === 'UL', '可见考试区域结构未知', 'unrecognizedCourseStructure');
      const displayedExams = [...examList.querySelectorAll(':scope > li > span')];
      require(displayedExams.length === course.exams.length, '可见考试数量不一致', 'pageMismatch');
      course.exams.forEach((e, i) => {
        keys(e, meetingKeys, 'unrecognizedCourseStructure');
        if (text(e.location)) require(displayedExams[i].textContent.replace(/\s+/g, ' ').includes(e.location), '可见考试地点不一致', 'pageMismatch');
      });
      const visibleComponents = [...region.querySelectorAll('ul strong[id]')];
      require(visibleComponents.length === components.reduce((n, c) => n + (c.meetings?.length || 0), 0), '可见 meeting 数量不一致', 'pageMismatch');
      const courseExams = components.flatMap(c => c.exams || []);
      const examIdentity = e => [e.exam, e.meetingOrExamNumber, e.dayInitials, e.start, e.end, e.online];
      const sameExam = (a, b) => JSON.stringify(examIdentity(a)) === JSON.stringify(examIdentity(b));
      unique(course.exams.map(e => e.meetingOrExamNumber));
      require(course.exams.every(e => courseExams.some(x => sameExam(e, x))), '考试关联区域不一致', 'pageMismatch');
      for (const c of components) rows.push(parseComponent(c, course, data, visibleComponents, sameExam));
    }
    return rows;
  }

  function extractUWRawSchedule(document) {
    const scripts = [...document.scripts].filter(s => !s.src && s.type === 'module' && s.textContent.includes('const data = '));
    require(scripts.length === 1, '课表内嵌数据结构尚未核验', 'scheduleDataNotFound');
    const matches = [...scripts[0].textContent.matchAll(/const data = (\{[^\n]+\});/g)];
    require(matches.length === 1 && matches[0][1].length < 4000000, '课表 JSON 边界未知或超限', 'scheduleDataNotFound');
    let data;
    try {
      data = JSON.parse(matches[0][1]);
    } catch {
      fail('内嵌 JSON 无法解析', 'scheduleDataNotFound');
    }
    keys(data, ['netId', 'termCode', 'terms', 'timeRange', 'events', 'courses', 'classes', 'courseForClassId', 'classesForCourseId']);

    const term = parseTerm(data, document);

    require(Array.isArray(data.courses) && Array.isArray(data.classes), '课程或组件区域未提供', 'scheduleDataNotFound');
    require(data.classes.length > 0 && data.classes.length <= 2000, '空课表状态尚未核验，未生成空快照', 'emptyScheduleUnverified');
    unique(data.courses.map(c => c.id));
    unique(data.classes.map(c => c.id));

    const regions = [...document.querySelectorAll('#courses-list > div')];
    require(regions.length === data.courses.length, '可见课程数量不一致', 'pageMismatch');
    const mapKeys = Object.keys(data.courseForClassId || {});
    const groupKeys = Object.keys(data.classesForCourseId || {});
    require(mapKeys.length === data.classes.length && groupKeys.length === data.courses.length, '课程关联不完整', 'schemaMismatch');

    const rows = parseCourses(data, document, regions);

    require(rows.length === data.classes.length && new Set(rows.map(r => r.rowKey)).size === data.classes.length, '组件关联存在遗漏或重复', 'schemaMismatch');
    require(document.querySelector('#term-code').selectedOptions[0].value === data.termCode, '提取期间学期改变', 'termNotFound');

    const available = Array.isArray(data.terms?.available) ? data.terms.available : [];
    const latestCode = latestTermCode(available);
    const latestTerm = latestCode == null ? null :
      available.find(t => t && /^\d+$/.test(String(t.code)) && parseInt(t.code, 10) === latestCode) || null;

    return {
      formatVersion: 1,
      adapterVersion: PARSER_VERSION,
      pageIdentifier: PAGE_IDENTIFIER,
      evidence: 'livePage',
      termKey: data.termCode,
      termName: term.name,
      latestTermKey: latestTerm ? latestTerm.code : null,
      latestTermName: latestTerm ? latestTerm.name : null,
      officialTermID: known(data.termCode),
      complete: true,
      confirmedEmpty: false,
      expectedComponentCount: data.classes.length,
      examRegionRead: true,
      rows,
    };
  }

  // --- normalise (mirrors ScheduleNormalizer.normalize) -----------------------

  async function normalizeUWSchedule(raw, context) {
    assert(raw.formatVersion === 1, '不支持的提取格式');
    assert(raw.evidence === context.expectedEvidence, '真实网页与测试样本来源不匹配');
    assert(raw.termKey === context.expectedTermKey, '提取期间学期发生变化，请重新提取');
    assert(raw.complete === true && raw.examRegionRead === true, '课表或考试区域未完整读取');
    assert(raw.expectedComponentCount === raw.rows.length && raw.rows.length <= 2000, 'component 数量不一致或超限');
    assertUnique(raw.rows.map(r => r.rowKey));
    assertNonempty([raw.termKey, raw.termName, raw.pageIdentifier, raw.adapterVersion]);

    const termID = await stableIdentity(['uw-term', raw.termKey]);
    const courses = new Map();
    const issues = [];

    for (const row of raw.rows) {
      validateField(row.exams, 'row.exams');
      if (row.exams.value) {
        assertUnique(row.exams.value.map(e => e.id));
        assertNonempty(row.exams.value.map(e => e.id));
      }
      assert(row.termKey === raw.termKey, '返回内容混入另一学期');
      assertNonempty([row.rowKey, row.componentKey]);
      const subject = row.subject.trim();
      const number = row.catalogNumber.trim();
      const association = row.enrollmentKey != null ? row.enrollmentKey.trim() : null;
      assert(association == null || association !== '', '空课程关联键');

      const courseID = await stableIdentity([context.dataSpaceID, context.scopeID, termID, subject, number,
      association == null ? 'unlinked-row' : 'enrollment', association ?? row.rowKey]);
      const componentID = await stableIdentity([courseID, row.componentKey]);

      const meetings = row.meetings.map(m => ({ ...m }));
      for (const m of meetings) {
        assertNonempty([m.id]);
        m.id = await stableIdentity([componentID, m.id]);
      }

      const component = {
        id: componentID,
        officialID: row.officialComponentID,
        type: row.type,
        section: row.section,
        session: row.session,
        meetings,
      };

      let exams = row.exams;
      if (exams.value) {
        const values = [];
        for (const e of exams.value) {
          const exam = { ...e };
          exam.id = await stableIdentity([courseID, 'exam', e.id]);
          exam.componentIDs = [componentID];
          values.push(exam);
        }
        exams = { ...exams, value: values };
      }

      if (courses.has(courseID)) {
        const existing = courses.get(courseID);
        assert(existing.title === row.title, '同一课程关联存在冲突标题');
        assert(!existing.components.some(c => c.id === componentID), '重复 component');
        existing.components.push(component);
        assert(existing.exams.state === exams.state, '同一课程考试发布状态冲突');
        if (exams.value) {
          for (const exam of exams.value) {
            const index = existing.exams.value ? existing.exams.value.findIndex(e => e.id === exam.id) : -1;
            if (index >= 0) {
              const previous = existing.exams.value[index];
              assert(JSON.stringify(previous.date) === JSON.stringify(exam.date) &&
                JSON.stringify(previous.time) === JSON.stringify(exam.time) &&
                JSON.stringify(previous.location) === JSON.stringify(exam.location), '相同考试键对应不同考试字段');
              existing.exams.value[index].componentIDs = Array.from(new Set([...previous.componentIDs, ...exam.componentIDs])).sort();
            } else {
              existing.exams.value.push(exam);
            }
          }
        }
        courses.set(courseID, existing);
      } else {
        if (association == null) issues.push({ path: courseID, message: '缺少可靠课程关联，保留独立记录' });
        courses.set(courseID, {
          id: courseID,
          termID: termID,
          subject,
          catalogNumber: number,
          title: row.title,
          association: association != null ? known(association) : missing(),
          components: [component],
          exams,
        });
      }
    }

    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      id: await stableIdentity([context.dataSpaceID, context.scopeID, termID, context.extractedAt]),
      dataSpaceID: context.dataSpaceID,
      timeZone: TIME_ZONE,
      term: { id: termID, officialID: raw.officialTermID, name: raw.termName },
      source: {
        type: 'scriptJSON',
        scopeID: context.scopeID,
        evidence: raw.evidence,
        pageIdentifier: raw.pageIdentifier,
        parserVersion: raw.adapterVersion,
        extractedAt: context.extractedAt,
      },
      complete: raw.complete,
      confirmedEmpty: raw.confirmedEmpty,
      courses: Array.from(courses.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      issues,
    };
    snapshot.issues = validateSnapshot(snapshot);
    return snapshot;
  }

  // --- build the portable document (mirrors UserScheduleData) ------------------

  function buildMadScheduleExport(snapshot) {
    return { schemaVersion: SCHEMA_VERSION, revision: 1, dataSpaceID: snapshot.dataSpaceID, snapshots: [snapshot] };
  }

  function serializeExport(doc) { return JSON.stringify(doc, null, 2); }

  function buildFilename(termName, termCode) {
    const slug = String(termName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `mad-schedule-${slug || String(termCode || 'export')}.json`;
  }

  const CORE = Object.freeze({
    DEBUG,
    SCHEMA_VERSION,
    TIME_ZONE,
    PARSER_VERSION,
    PAGE_IDENTIFIER,
    latestTermCode,
    isOlderTerm,
    UWParserError,
    ExportValidationError,
    stableIdentity,
    randomUUID,
    detectCourseSchedulePage,
    extractUWRawSchedule,
    parseTerm,
    parseCourses,
    parseComponent,
    parseMeetings,
    parseLocation,
    parseExams,
    normalizeUWSchedule,
    buildMadScheduleExport,
    validateExport,
    validateSnapshot,
    isValidDate,
    isValidTime,
    isValidInstant,
    buildFilename,
    serializeExport,
    known,
    missing,
    na,
  });

  /*::CORE-END::*/

  // ---------------------------------------------------------------------------
  // Browser wiring below. Everything from here on touches the DOM only; it is
  // excluded from the Node test harness.
  // ---------------------------------------------------------------------------

  function safeLog(...args) { if (DEBUG) console.log('[MadScheduleExporter]', ...args); }

  async function waitForReady() {
    if (document.readyState === 'complete') return;
    const deadline = Date.now() + 10000;
    while (document.readyState !== 'complete') {
      if (Date.now() > deadline) throw new UWParserError('页面加载超时，请等待官方课表显示后重试', 'pageTimeout');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  function renderExportButton() {
    if (document.getElementById('madschedule-export-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'madschedule-export-btn';
    btn.type = 'button';
    btn.textContent = 'Export for MadSchedule';
    btn.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483000;padding:8px 12px;' +
      'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff;background:#c5050c;' +
      'border:none;border-radius:6px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.3);';

    const status = document.createElement('div');
    status.id = 'madschedule-export-status';
    status.setAttribute('role', 'status');
    status.style.cssText = 'position:fixed;bottom:56px;right:12px;z-index:2147483000;max-width:340px;' +
      'padding:10px 12px;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      'background:#fff;border:1px solid #ccc;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.2);' +
      'display:none;white-space:pre-wrap;color:#222;';

    btn.addEventListener('click', onExport);

    document.body.appendChild(btn);
    document.body.appendChild(status);
  }

  function showExportStatus(message, kind) {
    const el = document.getElementById('madschedule-export-status');
    if (!el) return;
    el.textContent = message;
    el.style.display = 'block';
    el.style.color = kind === 'error' ? '#c5050c' : kind === 'warning' ? '#8a6d00' : '#222';
    el.style.borderColor = kind === 'success' ? '#1e7e34' : kind === 'error' ? '#c5050c' : kind === 'warning' ? '#d39e00' : '#ccc';
  }

  function logCounts(snapshot) {
    const courses = snapshot.courses.length;
    const components = snapshot.courses.reduce((n, c) => n + c.components.length, 0);
    const meetings = snapshot.courses.reduce((n, c) => n + c.components.reduce((m, cp) => m + cp.meetings.length, 0), 0);
    const exams = snapshot.courses.reduce((n, c) => n + (c.exams.value ? c.exams.value.length : 0), 0);
    safeLog('detectedTerm', snapshot.term.name, snapshot.term.officialID.value);
    safeLog('counts', { courses, components, meetings, exams });
  }

  function downloadJSON(document, doc, filename) {
    const json = JSON.stringify(doc, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function onExport() {
    showExportStatus('Extracting schedule…', 'working');
    try {
      await waitForReady();

      const raw = extractUWRawSchedule(document);
      const older = isOlderTerm(raw.termKey, raw.latestTermKey);
      safeLog('stage', 'extracted', raw.termKey, raw.termName, raw.expectedComponentCount, 'latest:', raw.latestTermKey, 'older:', older);

      // Terms before the current/latest term fall outside the app's academic
      // calendar, so they may fail to import. Confirm before exporting so the
      // student understands the risk.
      if (older) {
        const proceed = confirm(
          `${raw.termName} predates the current term${raw.latestTermName ? ` (${raw.latestTermName})` : ''}.\n\n` +
          `Please confirm the current academic calendar version in MadSchedule, and make sure ` +
          `it covers this term; otherwise this file may fail to import.\n\n` +
          `Continue with the export?`
        );
        if (!proceed) {
          safeLog('cancelled', 'user declined older-term export');
          showExportStatus('Export cancelled.', 'warning');
          return;
        }
      }

      const context = {
        dataSpaceID: randomUUID(),
        scopeID: randomUUID(),
        extractedAt: new Date().toISOString(),
        expectedEvidence: 'livePage',
        expectedTermKey: raw.termKey,
      };

      const snapshot = await normalizeUWSchedule(raw, context);
      logCounts(snapshot);

      const doc = buildMadScheduleExport(snapshot);
      validateExport(doc);
      safeLog('validation', 'ok');

      const filename = buildFilename(snapshot.term.name, snapshot.term.officialID.value ?? snapshot.term.id);
      downloadJSON(document, doc, filename);

      if (!older) {
        showExportStatus(`MadSchedule export ready\n${snapshot.term.name}\n${snapshot.courses.length} course(s)\nSaved as ${filename}`, 'success');
      } else {
        showExportStatus(`MadSchedule export ready\n${snapshot.term.name}\n${snapshot.courses.length} course(s)\nSaved as ${filename}\n\nNote: this term predates the current term. Please confirm the current academic calendar version in MadSchedule.`, 'warning');
      }
    } catch (err) {
      // Fixed, non-sensitive reason only. Never surfaces raw page HTML, cookies,
      // or any student identity data.
      const reason = (err && err.message) ? err.message : String(err);
      console.error('[MadScheduleExporter] export failed:', reason);
      showExportStatus('Unable to export this schedule.\nThe UW Course Schedule page format may have changed.\n\n' + reason, 'error');
    }
  }

  function init() {
    if (!detectCourseSchedulePage()) return;
    renderExportButton();
  }

  if (typeof document !== 'undefined') init();
})();
