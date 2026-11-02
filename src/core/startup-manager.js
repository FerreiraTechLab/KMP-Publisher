const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function desktopQuote(value) {
  const text = String(value || "");
  if (!text || /[\r\n]/.test(text)) throw new Error("Caminho inválido para inicialização automática.");
  return `"${text.replace(/[\\`"$]/g, "\\$&")}"`;
}

class StartupManager {
  constructor(electronApp, options = {}) {
    this.app = electronApp;
    this.platform = options.platform || process.platform;
    this.environment = options.environment || process.env;
    this.home = options.home || os.homedir();
    this.execPath = options.execPath || process.execPath;
    const configHome = this.environment.XDG_CONFIG_HOME || path.join(this.home, ".config");
    this.desktopPath = options.desktopPath || path.join(configHome, "autostart", "kmp-publisher.desktop");
  }

  executable() {
    return this.platform === "linux" && this.environment.APPIMAGE ? this.environment.APPIMAGE : this.execPath;
  }

  async setEnabled(enabled) {
    const active = Boolean(enabled);
    if (this.platform === "linux") {
      if (!active) { await fs.rm(this.desktopPath, {force: true}); return {enabled: false}; }
      await fs.mkdir(path.dirname(this.desktopPath), {recursive: true});
      const executable = this.executable();
      const document = `[Desktop Entry]\nType=Application\nName=KMP Publisher\nComment=Inicia o nó de distribuição KMP\nExec=${desktopQuote(executable)} --background\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
      const temporary = this.desktopPath + ".tmp";
      await fs.writeFile(temporary, document, {mode: 0o644});
      await fs.rename(temporary, this.desktopPath);
      return {enabled: true, executable};
    }
    this.app.setLoginItemSettings({openAtLogin: active, path: this.execPath,
      args: active ? ["--background"] : []});
    return {enabled: active, executable: this.execPath};
  }
}

module.exports = {desktopQuote, StartupManager};
