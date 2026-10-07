// Runs an ACP adapter (argv[2], a Node script talking JSON-RPC on stdio) inside an Electron utility
// process. The shipped app cannot run itself as plain Node (RunAsNode fuse off), and a utility process
// has no stdin, so stdin and stdout are carried over the parent port, one message per chunk.
import { PassThrough, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const port = process.parentPort;
const stdin = new PassThrough();
const stdout = new Writable({ write(chunk, _enc, cb) { port.postMessage(String(chunk)); cb(); } });
Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
port.on('message', (e) => { if (typeof e.data === 'string') stdin.write(e.data); else stdin.end(); });
import(pathToFileURL(process.argv[2]).href).catch((err) => { console.error(err); process.exit(1); });
