# Vercel + Render Deployment

## 1) Push to GitHub
1. Push this repository to GitHub.

## 2) Deploy Backend to Render
1. In Render, create a new **Web Service** from this GitHub repo.
2. Use these settings:
   - Build Command: `npm ci && npm run build`
   - Start Command: `npm start`
   - Health Check Path: `/health`
3. Set environment variables:
   - `CORS_ORIGINS=https://<your-vercel-domain>`
   - If you have multiple domains, separate with commas:
     - `https://your-app.vercel.app,https://your-custom-domain.com`
4. Deploy and copy your backend URL, for example:
   - `https://red-door-killer-key-backend.onrender.com`

## 3) Configure Frontend Socket Target
1. Edit `web/runtime-config.js`:
   - `window.RED_DOOR_SOCKET_SERVER_URL = "https://<your-render-domain>";`
2. Commit and push.

## 4) Deploy Frontend to Vercel
1. In Vercel, import this GitHub repo.
2. Framework Preset: `Other`.
3. Root Directory: repo root.
4. Output Directory: `web`.
5. Deploy.

## 5) Verify
1. Open the Vercel URL.
2. Top connection hint should show the Render URL.
3. Create room and join from another browser/device.

## Notes
1. You can temporarily override socket backend with URL query:
   - `https://your-vercel-domain.vercel.app/?server=https://your-render-domain.onrender.com`
2. Backend CORS is controlled by `CORS_ORIGINS`.
3. For local development, leave `web/runtime-config.js` empty and run backend locally.
