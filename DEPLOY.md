# CamOp MVP: deploy and self-test

## What this version does
- Records the guest's camera and mic to their own disk (IndexedDB) every 2 seconds.
- Uploads 8 MB parts to storage while the call is running, through CamOp's own address (no bucket CORS setup, one hostname for firewalls).
- Survives a tab refresh or crash, a lost connection, and a server restart: on reload, the page finishes the upload from disk.
- Records a separate audio-only safety file alongside every take.
- Guest links are signed; the dashboard needs a password.
- Live health on each guest tile: MB recorded and uploaded, resolution, mic level, warnings.

## Deploy on Railway
1. Railway: Hobby plan, then New Project > Deploy from GitHub repo > `christophchandler/camop`, branch `mvp` (or point the existing camop service at the `mvp` branch).
2. Variables (service > Variables):
   - `B2_ACCOUNT_ID` = the application key's keyID
   - `B2_APPLICATION_KEY` = the application key
   - `B2_BUCKET_NAME` = e.g. `camop-recordings`
   - `B2_BUCKET_ENDPOINT` = `https://` + the bucket's Endpoint, e.g. `https://s3.us-west-004.backblazeb2.com`
   - `DASHBOARD_PASSWORD` = a long password
3. Settings > Networking > Generate Domain. Open `https://<domain>/api/health`: `storageConfigured` must be `true`.

## Five-minute self-test (do this before a real call)
1. Open the dashboard, sign in, create a session, copy the link.
2. Open the link in a second browser window, type a name, tick consent, Join, confirm devices.
3. Start Recording from the dashboard. Within about 30 seconds the tile should show MB uploaded climbing.
4. Reload the guest window mid-recording. It should show "Saving your recording" and finish on its own.
5. Join again, record 30 seconds, Stop. The tile lists a camera file and an audio file with sizes.
6. In Backblaze, open the bucket: files are under `recordings/<session id>/`. Download one and play it.

## On a real call
- Guest on a laptop or desktop, Chrome or Safari, wired headphones, plugged in.
- Keep the CamOp tab open until it says "All saved."
- Keep a backup recording until this has a few real calls behind it.
- Chrome's MP4 files are variable frame rate. If Descript shows drift, use its Repair audio drift tool or convert to constant frame rate first.

## Test suite
`python3 tests/e2e_test.py` runs a local S3, the server and headless Chrome with a fake camera, then checks upload-while-recording, a mid-take reload, a server crash mid-take, and decodes every stored file.
