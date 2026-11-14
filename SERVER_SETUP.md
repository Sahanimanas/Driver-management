# Server setup

Linux server, app in `/root/Driver-management`, run by pm2 (`ecosystem.config.cjs`).

## Requirements

- **Node 22.13 or newer** (22 LTS or 24). Both the database (`node:sqlite`) and the
  PDF reader (`pdfjs-dist`) need it. Check with `node -v`.
- git, and pm2 (`npm install -g pm2`).
- Internet access on the first scan, to download the OCR language pack
  (or copy it in by hand, see below).

## First install

```bash
cd /root
git clone <repo-url> Driver-management
cd Driver-management

npm run install:all                      # server + web dependencies
cp server/.env.example server/.env
nano server/.env                         # at least set JWT_SECRET to a long random string

npm run check:ocr                        # every line should say OK
npm run build                            # build the web app

pm2 start ecosystem.config.cjs
pm2 save
pm2 startup                              # run the command it prints, so pm2 survives a reboot
```

API on port 4000, web on port 5180 (it forwards `/api` to 4000).

## Every update

```bash
cd /root/Driver-management
git pull
npm run install:all                      # always: new commits can add packages
npm run check:ocr
pm2 restart driver-mgmt-api driver-mgmt-web --update-env
```

Skipping `npm run install:all` after a pull is the usual reason scans work on a
laptop and fail on the server. The app still starts, but quietly falls back to a
weaker PDF reader that cannot read the portal's "Print to PDF" pages.

## If scanning does not work

1. **Run `npm run check:ocr`** and fix whatever it reports.

2. **Look at the logs:** `pm2 logs driver-mgmt-api --lines 100`
   - `[pdf] pdf.js unavailable` means pdf.js or the canvas didn't load.
     Run `cd server && rm -rf node_modules && npm install`. Do not use `--omit=optional`:
     the canvas's Linux binary is an optional package.
   - `[ocr] local engine unavailable` means the language pack couldn't be downloaded.
     See step 4.

3. **Check that pm2 uses the right Node.** pm2 keeps the Node it was started with,
   even after you upgrade Node.
   ```bash
   pm2 describe driver-mgmt-api | grep -i "node.js version"
   ```
   If that is older than `node -v`, run:
   ```bash
   npm install -g pm2
   pm2 kill
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2 startup                            # run the command it prints
   ```

4. **No internet on the server?** Copy the language pack from a machine where
   scanning works (`server/data/ocr/eng.traineddata`, about 5 MB) to the same path
   on the server:
   ```bash
   scp server/data/ocr/eng.traineddata root@<server>:/root/Driver-management/server/data/ocr/
   ```
   Then restart the API. A failed download is remembered until the next restart.

5. **Test with real files:**
   `npm run test:extraction -- /path/to/file.pdf` shows which engine read the file
   and what came out.
