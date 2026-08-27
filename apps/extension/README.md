# Roll Together extension

The extension targets Manifest V3 on Chrome and Firefox. A shared base manifest plus small browser overrides generate each packaged manifest:

- `manifest.base.json`
- `manifest.chrome.json`
- `manifest.firefox.json`

Firefox uses a Manifest V3 event page because Firefox does not currently run extension background service workers.

Supported browsers are Chrome 116 or newer and Firefox 142 or newer. Firefox 142 is the minimum version that consistently supports the extension's required data-collection declaration on desktop and Android.

## Build

From the repository root:

```bash
npm run build:chrome
npm run build:firefox
npm run build:production
```

Outputs:

- Development Chrome: `apps/extension/build`
- Development Firefox: `apps/extension/build-firefox`
- Production Chrome: `apps/extension/build-production`
- Production Firefox: `apps/extension/build-production-firefox`

Development builds use `http://localhost:3000`; production builds use the URL in `env.json`.

For local development, run `npm run dev` from the repository root. It watches the Chrome extension and shared protocol while automatically restarting the local backend. Production builds use separate directories and will not replace this localhost build.

## Load from source

### Chrome

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `apps/extension/build`.

### Firefox

Open `about:debugging`, choose **This Firefox**, choose **Load Temporary Add-on**, and select `apps/extension/build-firefox/manifest.json`.

## Release version

```bash
npm run version:bump -w roll_together_extension -- patch
```

Use `minor` or `major` as needed. The release workflow verifies and reads the single version in `manifest.base.json`.
