#!/usr/bin/env node
import { main } from "../src/cli.js";

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((exc) => {
    console.error(`Unexpected error: ${exc.stack || exc}`);
    process.exitCode = 1;
  });
