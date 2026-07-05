# Phase 1 - Upload Safety Handoff

Branch: `saas/phase1-upload-safety`
Status: test-only staging validation still needed; not deployed, not merged.

## Files changed
- `server.js`
- `lib/uploadSafety.js`
- `tests/upload_safety.test.js`
- `tests/test_upload_safety_http.js`
- `PHASE1_UPLOAD_SAFETY_HANDOFF.md`

## Upload rules implemented
- CSV-only launch mode: exactly one multipart file, final extension must be
  `.csv`.
- Filename must be a safe basename: ASCII letters/numbers plus space, dot,
  dash, underscore, and parentheses; no `/`, `\`, `:`, control chars, leading
  dot, `..`, absolute paths, or dangerous embedded extensions.
- Blocked examples include `.exe`, `.csv.exe`, `.zip`, `.sh`, `.js`, and
  `.exe.csv`.
- Max upload body: 50 MiB. Oversize returns `413` before proxying.
- Allowed file MIME: `text/csv`, `text/x-csv`, `application/csv`,
  `application/vnd.ms-excel`, `text/plain`, empty, or octet-stream.
- Lightweight content sniff rejects PE/ELF, ZIP/JAR/XLSX, gzip, PDF, PNG, JPEG,
  RAR, 7z, shebang scripts, HTML/script starts, NUL bytes, and binary controls.
- Full malware scanning is not implemented; keep as a launch hardening follow-up
  if untrusted uploads remain enabled.

## Tests added
- Unit validator tests: valid CSV, bad filenames, bad extensions, bad MIME,
  hidden binary/archive/script content, oversize.
- Live HTTP tests: generated DB users, real login cookies, real cases, valid B
  upload, invalid uploads, A cannot upload to B case, A cannot access B file via
  direct/B-case/mixed A-case paths.

## Test commands and result
```
node --test tests/upload_safety.test.js
node --test tests/test_upload_safety_http.js
node --test tests/auth.test.js tests/ownership.test.js tests/upload_safety.test.js tests/test_upload_safety_http.js
node --check server.js
```

Local result: pass. Live HTTP upload tests parse and skip locally because
`DATABASE_URL` is not set.

## Remaining risks
- Same upload validation should be mirrored in the discovery backend if backend
  direct access is still possible.
- Download/file route coverage depends on a backend `file_id` from staging.
- Backend artifacts may remain until backend-side deletion/export is completed.

## Exact next step
Run `tests/test_upload_safety_http.js` against staging with `DATABASE_URL`,
`APP_ENV=staging`, and `BASE_URL`; if green, verify backend direct-access
hardening before launch.
