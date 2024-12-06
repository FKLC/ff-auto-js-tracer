const exampleWebsites = [
  "https://amazon.com",
  "https://chatgpt.com",
  "https://facebook.com",
  "https://google.com",
  "https://instagram.com",
  "https://linkedin.com",
  "https://pinterest.com",
  "https://reddit.com",
  "https://tiktok.com",
  "https://twitch.tv",
  "https://x.com",
  "https://youtube.com",
];

export default {
  jobs: exampleWebsites.map((url) => ({
    url,
    name: url,
    startProfiler: "beforeload",
    waitFor: 10000,
  })),
  firefoxPath:
    "YourFirefoxBuildDir/mozilla-unified/obj-ff/dist/Nightly.app/Contents/MacOS/firefox",
  reportDir: "reports",
  clearReportDir: false,
  dbPath: "analysis.db",
  launchOptions: {
    extraPrefsFirefox: {
      "layout.css.prefers-color-scheme.content-override": 0, // Dark mode
    }
  }
};
