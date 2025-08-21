# Auto JS Trace

This is an automated Firefox profiler. It will visit the pages you specify and record data produced by Firefox profiler's JS Tracer feature.

## Installation

Before installing this repo, make sure you have the following prerequisites:
- Linux or MacOS. Windows is not supported.
- You need at least Node v22.5.0 as this project depends on `node:sqlite` library.
- You need a custom Firefox build. You'll need to apply some patches to your custom build from [the Gist here](https://gist.github.com/FKLC/f752fede7217ca05c17611bf70c61ce9).
    - These two are a MUST:
        - update-signal-initiated-profiler-features-and-filters.diff
            - When the profiler is initiated from a signal, it will use the hardcoded features and filters. This patch modifies it to use the JSTracer feature.
        - signal-back-to-the-signaller-after-profiler-is-stopped.diff
            - This patch makes sure that the profiler signals back to the signaller (this tool) after the profiler is stopped. This is important as it tells this tool that the profiling is done and it can proceed to the next step. There's also [Bug 1905929](https://bugzilla.mozilla.org/show_bug.cgi?id=1905929) which is similar, but there's no work being done on it as of now.
    - These are optional, but recommended:
        - prevent-bot-detection.diff
            - Just sets navigator.webdriver to false. Some websites check this property to detect bots.
    - These are only for research purposes, you can skip them. They do show how you can extend the data collected by the profiler:
        - log-requested-fonts-and-font-fingerprinting.diff
            - Logs requested fonts by scripts. Also logs font fingerprinting attempts by utilizing Firefox's built-in font fingerprinting detection.
        - log-blocked-fonts.diff
            - Logs blocked fonts by the user's font blocking settings.
    - These are NOT recommended, avoid it if you can. It will break pages and potentially crash Firefox:
        - dont-use-super-verbose-and-hacky-and-unstable-js-tracer.diff
            - This patch injects code to every JS function (including getters and setters) and logs every function call's arguments and return values. This is extremely hacky and unstable, and will break maaaany pages.

1. Clone this repository
1. Run `npm install`
1. Rename [`example.user.config.js`](example.user.config.js) to `user.config.js` and fill in the necessary fields.
    - `firefoxPath`: Path to the Firefox binary you want to use.
    - `jobs`: Websites you want to profile. See [types > ProfileJob](src/types.d.ts) and example config for its structure.

## Usage

1. Run `npm run esbuild`
1. Run `npm start`

This should open Firefox and start profiling the websites you specified in `user.config.js`. Do note that writes to the database are done in every 10 profiles, so you won't see any data in the database until 10 profiles have been completed. You can configure this by modifying [Pipeline Class > CHUNK_SIZE](src/pipeline.ts)

## Database
By default, the database will be created in the root directory of this project. The database will be named `analysis.db`. You can choose another name/location by modifying `user.config.js`. The database will have a single table named `analysis`. The schema for this table is as follows:

```sql
CREATE TABLE IF NOT EXISTS ${Pipeline.TABLE_NAME} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firstPartyOrigin TEXT,
    firstPartyURL TEXT,
    thirdPartyOrigin TEXT,
    thirdPartyURL TEXT,
    scriptOrigin TEXT,
    scriptURLWOQuery TEXT,
    scriptURL TEXT,
    validScriptOrigin TEXT,
    validScriptURLWOQuery TEXT,
    validScriptURL TEXT,
    apiCalled TEXT NOT NULL,
    numCalls INTEGER NOT NULL
) STRICT;
```

The difference between `scriptURL` and `validScriptURL` is that `scriptURL` is the direct parent in the call stack (which may or may not be a JS Frame, only JS frames have script URL), while `validScriptURL` is the first valid parent with a valid script URL in the call stack. Generally speaking, `validScriptURL` is the more useful field.

## Terminology

DOM events: refers to the events recorded by the JS Tracer feature.

## Limitations

- Bot detection: While I haven't ran into any issues, as this is an automated Firefox instance, you may run into bot detection issues on some websites.
- [Stacks with no JS](https://bugzilla.mozilla.org/show_bug.cgi?id=1935175): Sometimes the profiler records DOM events with no JS stack. What I mean by this is, usually a DOM event is triggered by a JS function. However, sometimes the profiler records a DOM event with no JS stack. This is a limitation of the profiler and not this tool. It generally happens when the JS code is running in a script tag in a document at the top-level scope. These calls are not reflected to the analysis as we can't match them to a specific window.
