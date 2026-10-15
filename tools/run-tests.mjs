// tools/run-tests.mjs —— 在受限沙箱里跑 node:test 并把输出写进文件
//
// 为什么需要它：node --test 会用 child_process 的管道收集子进程输出，
// 而受限沙箱禁止子进程打开命名管道（EPERM）。这里改成在进程内重定向 fd 1/2 到
// 真实文件，既不经过管道，也仍然打印 node:test 的完整 TAP 风格结果。
//
// 用法：node tools/run-tests.mjs [--log=path] <testfile> [more...]
import { closeSync, openSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
let logPath = null;
const files = [];
for (const a of args) {
  const m = /^--log=(.*)$/.exec(a);
  if (m) logPath = m[1];
  else files.push(a);
}
if (files.length === 0) {
  console.error('用法: node tools/run-tests.mjs [--log=out.log] <testfile> [...]');
  process.exit(2);
}
logPath = resolve(logPath || '.test-run.log');

const fd = openSync(logPath, 'w');
const w = (s) => {
  try {
    writeSync(fd, s);
  } catch {
    /* 输出失败不影响测试结果 */
  }
};

process.argv = [process.argv[0], process.argv[1], ...files];
process.on('uncaughtException', (e) => {
  w('\n[uncaughtException] ' + (e && e.stack ? e.stack : String(e)) + '\n');
  process.exitCode = 1;
});

const { run } = await import('node:test');
const stream = run({ files, concurrency: 1, timeout: 60000 });
let pass = 0;
let fail = 0;
stream.on('test:pass', (t) => {
  if (t.skip) return;
  pass++;
  w(`ok   ${t.name}\n`);
});
stream.on('test:fail', (t) => {
  fail++;
  w(`FAIL ${t.name}\n`);
  if (t.details && t.details.error) w(String(t.details.error.stack || t.details.error.message) + '\n');
});
stream.on('error', (e) => w(`[runner error] ${e && e.stack ? e.stack : e}\n`));
await new Promise((r) => stream.on('close', r));

w(`\n# pass ${pass}\n# fail ${fail}\n`);
closeSync(fd);
// 有失败就让调用方看见非零退出码
process.exitCode = fail > 0 ? 1 : 0;
// 被子进程/定时器挂住时兜底退出（正常路径上事件循环已空，exit 会立即发生）
setTimeout(() => process.exit(fail > 0 ? 1 : 0), 250).unref();
