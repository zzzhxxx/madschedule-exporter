# Changelog

## 1.0.2 — 2026-10-02

- Update the English and Chinese userscript descriptions to clarify JSON file import into MadSchedule.
- Synchronize the repository version and publishing instructions with userscript version 1.0.2.

## 1.0.1 — 2026-10-02

- Prepare a standalone repository with MIT licensing, usage and publishing docs.
- Add Chinese userscript metadata and GitHub support/update links.
- Restrict URL matches to the two schedule paths already accepted by the parser.
- Make regression fixtures local to this repository and add distribution checks and CI.
- Keep the schedule extraction logic and JSON v1 output unchanged.

## 1.0.0

- Export the currently displayed UW–Madison Course Schedule as MadSchedule JSON v1.
- Preserve course components, meetings, online modes and visible exams.
- Validate before downloading; require confirmation for terms older than the latest selectable term.
