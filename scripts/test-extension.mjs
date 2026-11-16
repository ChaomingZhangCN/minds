import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform === 'linux' && !process.env.DISPLAY) {
  throw new Error('原生 Extension Host 测试需要桌面 DISPLAY；当前环境没有显示服务。请在本机桌面运行，或自行配置 xvfb-run -a npm run test:extension。没有运行原生测试。');
}
const extensionTestsPath = path.join(root, '.cache/extension-tests/suite.cjs');
await build({ entryPoints: [path.join(root, 'test/extension/suite.ts')], outfile: extensionTestsPath, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'] });
await runTests({
  extensionDevelopmentPath: root, extensionTestsPath,
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || undefined,
  version: '1.105.0', reuseMachineInstall: false,
  extensionTestsEnv: { MINDS_TEST_ROOT: root },
  launchArgs: [path.join(root, 'examples'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-extensions'],
});
