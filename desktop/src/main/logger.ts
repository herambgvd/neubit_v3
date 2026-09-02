import log from "electron-log/main";

// Central logger. electron-log writes to the OS log dir (and the console in dev)
// and captures unhandled errors and rejections from every process. Initialised
// once from index.ts, before anything else runs — a crash during startup with no
// log file is the hardest kind to be told about.
export function initLogging(): void {
  log.initialize();
  log.transports.file.level = "info";
  log.transports.console.level = process.env.NODE_ENV === "development" ? "debug" : "warn";
  log.errorHandler.startCatching({ showDialog: false });
  log.info("logging initialised");
}

export { log };
