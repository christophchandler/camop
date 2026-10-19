# CamOp MVP: deploy and self-test

## What this version does
- Records the guest's camera and mic to their own disk (IndexedDB) every 2 seconds.
- Uploads 8 MB parts to storage while the call is running, through CamOp's own address (no bucket CORS setup, one hostname for firewalls).
- Survives a tab refresh or crash, a lost connection, and a server restart: on reload, the page finishes the upload from disk.
- Records a separate audio-only safety file alongside every take.
- Guest links are signed; the dashboard needs a password.
- Live health on each guest tile: MB recorded and uploaded, resolution, mic level, warnings.
- Each session belongs to a project folder. Files are saved as
  `261019_Client_Project/2_FOOTAGE/1_VIDEO/CAMOP/20261019_141502_Guest_CAM_take01.mp4`, with a
  `camop_session_<id>.json` manifest beside them. A server restart restores sessions from those manifests.

## Constant frame rate
- In Chrome, Edge, Arc and other Chromium browsers on Mac and Windows, the camera file is recorded at an
  exact 29.97 fps (or 23.976, picked per session) by guest/cfr.js: WebCodecs H.264 + AAC on the guest's own
  GPU, every frame on a fixed grid, audio as the master clock, AAC start delay measured and compensated.
- It falls back to MediaRecorder (variable frame rate, flagged "VFR" on the dashboard) when the browser has
  no H.264/AAC encoder (Safari, Firefox, Chrome on Linux), when the computer can't encode the chosen size in
  real time (checked before each first take; e.g. 4K on older Intel Macs), or if the encoder falls more than
  three seconds behind mid-take. Variable-frame-rate files need a conform before editing.
- The camera is asked to lock at 30 fps (24 for 23.976 sessions). A camera that only delivers 24 or less is
  recorded on the 23.976 grid.
- `?cfr=0` on a guest link turns it off.
- Tests: `node tests/cfr_scheduler_test.js` (frame placement, 1 h drift, stalls), `python3 tests/cfr_browser_test.py`
  (real recorder in headless Chromium with VP9 + Opus: grid, length, sync, decode), `CFR=vp9 python3 tests/e2e_test.py`.

## Storage (keep CamOp away from the backup)
- CamOp has its own bucket, `christopherandcompany-camop`, and a key that can only reach it
  (`camop-railway`, Read and Write). Never point CamOp at the studio backup bucket.
- The bucket root mirrors the Shadow server's Projects folder. Synology Cloud Sync task "CamOp":
  key `shadow-cloudsync` (that bucket only, Read Only, list bucket names), remote path = bucket root,
  local path = `christopherandcompany/Projects`, "Download remote changes only", and
  "Don't remove files in the destination folder when they are removed in the source folder" ticked.

## Deploy on Railway
1. Railway: Hobby plan, then New Project > Deploy from GitHub repo > `christophchandler/camop`, branch `mvp` (or point the existing camop service at the `mvp` branch).
2. Variables (service > Variables):
   - `B2_ACCOUNT_ID` = the application key's keyID
   - `B2_APPLICATION_KEY` = the application key
   - `B2_BUCKET_NAME` = `christopherandcompany-camop`
   - `B2_BUCKET_ENDPOINT` = `https://` + the bucket's Endpoint, e.g. `https://s3.us-west-004.backblazeb2.com`
   - `DASHBOARD_PASSWORD` = a long password
3. Settings > Networking > Generate Domain. Open `https://<domain>/api/health`: `storageConfigured` must be `true`.

## Five-minute self-test (do this before a real call)
1. Open the dashboard, sign in, enter Client and Project (or tick "already on the server" and paste the folder name), create the session, copy the link.
2. Open the link in a second browser window, type a name, tick consent, Join, confirm devices.
3. Start Recording from the dashboard. Within about 30 seconds the tile should show MB uploaded climbing.
4. Reload the guest window mid-recording. It should show "Saving your recording" and finish on its own.
5. Join again, record 30 seconds, Stop. The tile lists a camera file and an audio file with sizes.
6. Within a few minutes the files show up on the Shadow server under `Projects/<folder>/2_FOOTAGE/1_VIDEO/CAMOP/`. Play one.

## On a real call
- Guest on a laptop or desktop, Chrome or Safari, wired headphones, plugged in.
- Keep the CamOp tab open until it says "All saved."
- Keep a backup recording until this has a few real calls behind it.
- Chrome's MP4 files are variable frame rate. If Descript shows drift, use its Repair audio drift tool or convert to constant frame rate first.

## Test suite
`python3 tests/e2e_test.py` runs a local S3, the server and headless Chrome with a fake camera, then checks upload-while-recording, a mid-take reload, a server crash mid-take, the project folder layout, file names, take numbers, the session manifest and its restore after a crash, the switch-camera request during a take, and decodes every stored file.
