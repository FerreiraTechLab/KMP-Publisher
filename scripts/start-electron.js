const {spawn} = require("node:child_process");
const electron = require("electron");

const environment = {...process.env};
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["."], {stdio: "inherit", env: environment});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
