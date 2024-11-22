# Auto JS Trace

This is an automated Firefox profiler. It will visit the pages you specify and record data produced by Firefox profiler's JS Tracer feature.

## Installation

Before installing this repo, make sure you have the following two:
- Linux or MacOS. Windows is not supported.
- You need at least Node v22.5.0 as this project depends on `node:sqlite` library.
- You need a specific Firefox build. Specifically a build that has this [patch stack](https://phabricator.services.mozilla.com/D229659). Make sure to check "Stack" tab to ensure this is indeed the latest patch in the stack. You can also download a build from [here](https://treeherder.mozilla.org/jobs?repo=try&resultStatus=success%2Crunnable&revision=4f2e8611907acc8d4c44c1d1054365441011b5d0&searchStr=build) but it may be outdated.

1. Clone this repository
1. Run `npm install`
1. Rename [`example.user.config.js`](example.user.config.js) to `user.config.json` and fill in the necessary fields.
    - `firefoxPath`: Path to the Firefox binary you want to use.
    - `jobs`: Websites you want to profile. See [types > ProfileJob](src/types.d.ts) and example config for its structure.

## Usage

1. Run `npm run esbuild`
1. Run `npm start -- [optional reports directory] [optional database path]`

This should open Firefox and start profiling the websites you specified in `user.config.json`. Do note that writes to the database are done in every 10 profiles, so you won't see any data in the database until 10 profiles have been completed. You can configure this by modifying [Pipeline Class > CHUNK_SIZE](src/pipeline.ts)
