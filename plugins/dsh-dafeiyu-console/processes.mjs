// Pure process ownership and PowerShell formatting helpers. No I/O at import.
import path from 'node:path';

const canonical = value => path.win32.normalize(String(value || '').replaceAll('/', '\\')).toLowerCase();
const literal = value => `'${String(value).replaceAll("'", "''")}'`;

export function windowsArguments(command) {
  const text = String(command || '');
  const args = [];
  let index = 0;
  while (index < text.length) {
    while (/\s/.test(text[index] || '') && index < text.length) index++;
    if (index >= text.length) break;
    let value = '', quoted = false;
    while (index < text.length) {
      if (!quoted && /\s/.test(text[index])) break;
      let slashes = 0;
      while (text[index] === '\\') { slashes++; index++; }
      if (text[index] === '"') {
        value += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) value += '"';
        else quoted = !quoted;
        index++;
      } else {
        value += '\\'.repeat(slashes);
        if (index < text.length) value += text[index++];
      }
    }
    args.push(value);
  }
  return args;
}

function rootMatches(row, bundle, service) {
  const exe = canonical(row.ExecutablePath);
  if (!exe) return false;
  const root = canonical(bundle);
  const args = windowsArguments(row.CommandLine);
  const normalized = args.map(canonical);
  if (service === 'napcat') {
    return exe.startsWith(root + '\\napcat\\') &&
      ['qq.exe', 'napcatwinbootmain.exe'].includes(path.win32.basename(exe));
  }
  const python = [root + '\\astrbot\\venv\\scripts\\python.exe', root + '\\runtime\\python\\python.exe'];
  const launcher = root + '\\astrbot\\venv\\scripts\\astrbot.exe';
  if (service === 'embed') {
    return python.includes(exe) && normalized.includes(root + '\\astrbot\\tools\\embed_server.py');
  }
  if (service !== 'astrbot') return false;
  if (exe === launcher) return args.slice(1).some(arg => arg === 'run' || arg === 'start');
  if (!python.includes(exe)) return false;
  const wrapper = normalized.indexOf(launcher);
  if (wrapper >= 0 && ['run', 'start'].includes(args[wrapper + 1])) return true;
  const module = args.indexOf('-m');
  return module >= 0 && args[module + 1] === 'astrbot.cli.__main__' &&
    ['run', 'start'].includes(args[module + 2]);
}

export function matchingProcesses(rows, bundle, service) {
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  const root = canonical(bundle) + '\\';
  const owned = new Set(list.filter(row => rootMatches(row, bundle, service)).map(row => Number(row.ProcessId)));
  let changed;
  do {
    changed = false;
    for (const row of list) {
      const id = Number(row.ProcessId);
      if (!Number.isSafeInteger(id) || id <= 0 || owned.has(id) || !owned.has(Number(row.ParentProcessId))) continue;
      if (!canonical(row.ExecutablePath).startsWith(root)) continue;
      if (['napcat', 'embed', 'astrbot'].some(other => other !== service && rootMatches(row, bundle, other))) continue;
      owned.add(id);
      changed = true;
    }
  } while (changed);
  return list.filter(row => owned.has(Number(row.ProcessId))).map(row => ({
    ProcessId: Number(row.ProcessId), ParentProcessId: Number(row.ParentProcessId),
    ExecutablePath: String(row.ExecutablePath), Started: String(row.Started || ''),
  }));
}

export function sameProcess(expected, current) {
  return !!expected && !!current && Number(expected.ProcessId) === Number(current.ProcessId) &&
    canonical(expected.ExecutablePath) === canonical(current.ExecutablePath) &&
    String(expected.Started) === String(current.Started);
}

export function processQueryScript() {
  return "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
    "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine," +
    "@{Name='Started';Expression={if($_.CreationDate){$_.CreationDate.ToUniversalTime().Ticks.ToString()}else{''}}}) | ConvertTo-Json -Compress";
}

export function killScript(records) {
  return "$ErrorActionPreference='Stop'; " + records.map(record => {
    if (!Number.isSafeInteger(record.ProcessId) || record.ProcessId <= 0 || !/^\d+$/.test(record.Started)) {
      throw new Error('缺少可靠的进程身份，拒绝停止');
    }
    return `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${record.ProcessId}'; ` +
      `if($null -ne $p){if($p.ExecutablePath -ine ${literal(record.ExecutablePath)} -or ` +
      `$p.CreationDate.ToUniversalTime().Ticks.ToString() -ne ${literal(record.Started)}){throw 'PID identity changed; refusing to stop'}; ` +
      `Stop-Process -Id ${record.ProcessId} -Force -ErrorAction Stop}`;
  }).join('; ');
}
