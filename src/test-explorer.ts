import { spawn } from 'child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, dirname, join } from 'path';
import {
	CancellationToken,
	debug,
	DebugSession,
	Disposable,
	ExtensionContext,
	Location,
	Position,
	Range,
	TestController,
	TestItem,
	TestMessage,
	TestRun,
	TestRunProfileKind,
	TestRunRequest,
	tests,
	Uri,
	workspace,
} from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

// Anbindung von jul test an die Testing API von VSCode, siehe jul-compiler/docs/test-explorer.md.
// Die Tests findet der Language Server (jul/tests, jul/testsChanged), ausgeführt wird mit dem global
// installierten jul, die Ergebnisse kommen über die Report-Datei von jul test --report.

//#region Typen

/**
 * Wie DiscoveredTest in test-discovery.ts des Language Servers.
 */
interface DiscoveredTest {
	name: string;
	range: {
		start: { line: number; character: number; };
		end: { line: number; character: number; };
	};
}

interface TestFileTests {
	uri: string;
	tests: DiscoveredTest[];
}

/**
 * Wie TestLocation in test-runtime.ts des Compilers: absoluter Pfad, 1-basiert.
 */
interface ReportLocation {
	file: string;
	row: number;
	column: number;
}

/**
 * Wie TestReportEvent in compiler.ts des Compilers.
 */
type ReportEvent =
	| {
		type: 'result';
		file?: string;
		name: string;
		location?: ReportLocation;
		failure?: string;
		failureLocation?: ReportLocation;
		durationMs: number;
	}
	| {
		type: 'compileFailed';
		errors: (ReportLocation & { message: string; })[];
	}
	| {
		type: 'finished';
		testCount: number;
		failedCount: number;
		skippedCount: number;
	};

/**
 * Ein Aufruf von jul test: ein Projekt, und entweder ganze Dateien oder einzelne Tests. Beides
 * zusammen ginge nicht, --name schränkte sonst auch die ganzen Dateien ein.
 */
interface Invocation {
	configPath: string;
	files: Set<string>;
	names: Set<string> | undefined;
	/**
	 * Die angeforderten Tests, ohne Datei-Items.
	 */
	items: TestItem[];
}

//#endregion Typen

export function registerTestExplorer(context: ExtensionContext, client: LanguageClient): void {
	const controller = tests.createTestController('julTests', 'JUL');
	context.subscriptions.push(controller);

	const updateFile = (fileTests: TestFileTests) => updateTestFile(controller, fileTests);
	context.subscriptions.push(client.onNotification('jul/testsChanged', updateFile));
	const loadAll = async () => {
		await client.start();
		const allFileTests = await client.sendRequest<TestFileTests[]>('jul/tests');
		allFileTests.forEach(updateFile);
	};
	controller.refreshHandler = loadAll;
	void loadAll();

	controller.createRunProfile(
		'Run',
		TestRunProfileKind.Run,
		(request, token) => runTests(controller, request, token, false),
		true);
	controller.createRunProfile(
		'Debug',
		TestRunProfileKind.Debug,
		(request, token) => runTests(controller, request, token, true),
		true);
}

//#region Baum

/**
 * Unter Windows ist die Groß- und Kleinschreibung des Laufwerksbuchstabens je nach Quelle
 * verschieden (Server-URI, Report-Pfad), der Pfad aber derselbe.
 */
function getFileId(fsPath: string): string {
	return process.platform === 'win32'
		? fsPath.toLowerCase()
		: fsPath;
}

function updateTestFile(controller: TestController, fileTests: TestFileTests): void {
	const uri = Uri.parse(fileTests.uri);
	const fileId = getFileId(uri.fsPath);
	if (!fileTests.tests.length) {
		controller.items.delete(fileId);
		return;
	}
	let fileItem = controller.items.get(fileId);
	if (!fileItem) {
		fileItem = controller.createTestItem(fileId, workspace.asRelativePath(uri), uri);
		controller.items.add(fileItem);
	}
	fileItem.children.replace(fileTests.tests.map(test => {
		const item = controller.createTestItem(test.name, test.name, uri);
		item.range = new Range(
			test.range.start.line,
			test.range.start.character,
			test.range.end.line,
			test.range.end.character);
		return item;
	}));
}

//#endregion Baum

//#region Ausführen

async function runTests(
	controller: TestController,
	request: TestRunRequest,
	token: CancellationToken,
	debugMode: boolean,
): Promise<void> {
	const run = controller.createTestRun(request);
	try {
		const cliPath = findGlobalJulCli();
		const invocations = getInvocations(controller, request, run);
		if (!cliPath) {
			invocations.flatMap(invocation => invocation.items).forEach(item => {
				run.errored(item, new TestMessage('The global jul was not found in PATH. Install it with npm i -g jul-compiler.'));
			});
			return;
		}
		for (const invocation of invocations) {
			if (token.isCancellationRequested) {
				invocation.items.forEach(item => run.skipped(item));
				continue;
			}
			await runInvocation(controller, invocation, cliPath, run, token, debugMode);
		}
	}
	finally {
		run.end();
	}
}

/**
 * Gruppiert die angeforderten Tests je Projekt in höchstens zwei Aufrufe: ganze Dateien und
 * einzelne Tests. Eine Datei mit ausgeschlossenen Tests zählt als Auswahl ihrer übrigen Tests.
 */
function getInvocations(controller: TestController, request: TestRunRequest, run: TestRun): Invocation[] {
	const excluded = new Set(request.exclude ?? []);
	const requested: TestItem[] = [];
	(request.include ?? [...controller.items].map(([, item]) => item)).forEach(item => {
		if (!excluded.has(item)) {
			requested.push(item);
		}
	});
	const invocations = new Map<string, Invocation>();
	const getInvocation = (configPath: string, singleTests: boolean) => {
		const key = `${configPath}|${singleTests}`;
		let invocation = invocations.get(key);
		if (!invocation) {
			invocation = {
				configPath: configPath,
				files: new Set(),
				names: singleTests ? new Set() : undefined,
				items: [],
			};
			invocations.set(key, invocation);
		}
		return invocation;
	};
	requested.forEach(item => {
		const fileItem = item.parent ?? item;
		const filePath = fileItem.uri!.fsPath;
		const configPath = findConfig(filePath);
		const children = [...fileItem.children].map(([, child]) => child);
		const selectedTests = item.parent
			? [item]
			: children.filter(child => !excluded.has(child));
		if (!configPath) {
			selectedTests.forEach(test => {
				run.errored(test, new TestMessage(`No jul-config.yaml found for ${filePath}.`));
			});
			return;
		}
		const wholeFile = !item.parent && selectedTests.length === children.length;
		const invocation = getInvocation(configPath, !wholeFile);
		invocation.files.add(filePath);
		selectedTests.forEach(test => {
			invocation.names?.add(test.id);
			invocation.items.push(test);
		});
	});
	return [...invocations.values()];
}

/**
 * Die nächste jul-config.yaml aufwärts, innerhalb des Workspace-Ordners.
 */
function findConfig(filePath: string): string | undefined {
	const workspaceFolder = workspace.getWorkspaceFolder(Uri.file(filePath))?.uri.fsPath;
	let folder = dirname(filePath);
	while (true) {
		const configPath = join(folder, 'jul-config.yaml');
		if (existsSync(configPath)) {
			return configPath;
		}
		const parent = dirname(folder);
		if (parent === folder
			|| (workspaceFolder && getFileId(folder) === getFileId(workspaceFolder))) {
			return undefined;
		}
		folder = parent;
	}
}

/**
 * Die cli.js hinter dem global installierten jul. Gestartet wird sie direkt mit node statt über
 * das Shim: Unter Windows ist jul ein .cmd, das nur über die Shell läuft, und dort müsste jedes
 * Argument (Testnamen mit Leerzeichen) von Hand gequotet werden. Der Debugger bekommt sie als
 * program.
 */
function findGlobalJulCli(): string | undefined {
	for (const folder of (process.env.PATH ?? '').split(delimiter)) {
		if (!folder) {
			continue;
		}
		if (process.platform === 'win32') {
			// Das Shim von npm i -g liegt neben dem node_modules der globalen Pakete.
			const cliPath = join(folder, 'node_modules', 'jul-compiler', 'out', 'compiler', 'cli.js');
			if (existsSync(join(folder, 'jul.cmd')) && existsSync(cliPath)) {
				return cliPath;
			}
		}
		else {
			// Sonst ist jul ein Symlink auf die cli.js.
			const binPath = join(folder, 'jul');
			if (existsSync(binPath)) {
				return realpathSync(binPath);
			}
		}
	}
	return undefined;
}

let reportCounter = 0;

async function runInvocation(
	controller: TestController,
	invocation: Invocation,
	cliPath: string,
	run: TestRun,
	token: CancellationToken,
	debugMode: boolean,
): Promise<void> {
	const reportPath = join(tmpdir(), `jul-test-report-${process.pid}-${reportCounter++}.jsonl`);
	const args = [
		'test',
		'--config', invocation.configPath,
		'--report', reportPath,
		...[...invocation.files].flatMap(file => ['--file', file]),
		...[...invocation.names ?? []].flatMap(name => ['--name', name]),
	];
	const cwd = dirname(invocation.configPath);
	invocation.items.forEach(item => run.started(item));
	try {
		const failureText = debugMode
			? await runDebugSession(cliPath, args, cwd, token)
			: await runProcess(cliPath, args, cwd, run, token);
		applyReport(controller, invocation, readReport(reportPath), failureText, run);
	}
	finally {
		rmSync(reportPath, { force: true });
	}
}

/**
 * Liefert bei einem Exit-Code ungleich 0 die Ausgabe, damit ein Abbruch ohne Report erklärt werden
 * kann.
 */
function runProcess(
	cliPath: string,
	args: string[],
	cwd: string,
	run: TestRun,
	token: CancellationToken,
): Promise<string | undefined> {
	return new Promise(resolve => {
		const child = spawn('node', [cliPath, ...args], { cwd: cwd });
		let output = '';
		const append = (data: Buffer) => {
			const text = data.toString();
			output += text;
			// Das Output-Terminal der Test Results braucht \r\n.
			run.appendOutput(text.replace(/\r?\n/g, '\r\n'));
		};
		child.stdout.on('data', append);
		child.stderr.on('data', append);
		const cancellation = token.onCancellationRequested(() => child.kill());
		child.on('error', error => {
			cancellation.dispose();
			resolve(error.message);
		});
		child.on('close', exitCode => {
			cancellation.dispose();
			resolve(exitCode === 0 ? undefined : output);
		});
	});
}

/**
 * Wartet auf das Ende der Session. Die Ausgabe steht in der Debug Console, nicht in den Test
 * Results.
 */
async function runDebugSession(
	cliPath: string,
	args: string[],
	cwd: string,
	token: CancellationToken,
): Promise<string | undefined> {
	const runId = `jul-test-${process.pid}-${reportCounter}`;
	let session: DebugSession | undefined;
	const disposables: Disposable[] = [];
	const terminated = new Promise<void>(resolve => {
		disposables.push(
			debug.onDidStartDebugSession(started => {
				if (started.configuration.julTestRunId === runId && !started.parentSession) {
					session = started;
				}
			}),
			debug.onDidTerminateDebugSession(ended => {
				if (ended.configuration.julTestRunId === runId && !ended.parentSession) {
					resolve();
				}
			}));
	});
	disposables.push(token.onCancellationRequested(() => {
		// Ohne Session stoppte stopDebugging alle laufenden Sessions.
		if (session) {
			void debug.stopDebugging(session);
		}
	}));
	try {
		const started = await debug.startDebugging(workspace.getWorkspaceFolder(Uri.file(cwd)), {
			type: 'node',
			request: 'launch',
			name: 'JUL tests',
			julTestRunId: runId,
			program: cliPath,
			args: args,
			cwd: cwd,
			skipFiles: [
				'<node_internals>/**',
				'**/jul-compiler/out/**',
			],
		});
		if (!started) {
			return 'The debug session could not be started.';
		}
		await terminated;
		return undefined;
	}
	finally {
		disposables.forEach(disposable => disposable.dispose());
	}
}

function readReport(reportPath: string): ReportEvent[] {
	if (!existsSync(reportPath)) {
		return [];
	}
	return readFileSync(reportPath, 'utf8')
		.split('\n')
		.filter(line => line)
		.map(line => JSON.parse(line) as ReportEvent);
}

function applyReport(
	controller: TestController,
	invocation: Invocation,
	events: ReportEvent[],
	failureText: string | undefined,
	run: TestRun,
): void {
	const reported = new Set<TestItem>();
	let finished = false;
	events.forEach(event => {
		switch (event.type) {
			case 'result': {
				const item = getResultItem(controller, event.file, event.name);
				if (!item) {
					return;
				}
				reported.add(item);
				if (event.failure === undefined) {
					run.passed(item, event.durationMs);
					return;
				}
				const message = new TestMessage(event.failure);
				const location = event.failureLocation ?? event.location;
				if (location) {
					message.location = toLocation(location);
				}
				run.failed(item, message, event.durationMs);
				return;
			}
			case 'compileFailed': {
				const messages = event.errors.map(error => {
					const message = new TestMessage(error.message);
					message.location = toLocation(error);
					return message;
				});
				invocation.items.forEach(item => {
					reported.add(item);
					run.errored(item, messages);
				});
				return;
			}
			case 'finished':
				finished = true;
				return;
		}
	});
	invocation.items
		.filter(item => !reported.has(item))
		.forEach(item => {
			// Ohne finished ist der Lauf abgebrochen, etwa weil jul selbst scheiterte.
			if (!finished && failureText !== undefined) {
				run.errored(item, new TestMessage(failureText || 'jul test failed without output.'));
			}
			else {
				run.skipped(item);
			}
		});
}

/**
 * Ein Ergebnis zu einem Test, den der Baum noch nicht kennt (Language Server noch nicht
 * nachgekommen), bekommt ein eigenes Item unter seiner Datei.
 */
function getResultItem(controller: TestController, file: string | undefined, name: string): TestItem | undefined {
	if (!file) {
		return undefined;
	}
	const fileItem = controller.items.get(getFileId(file));
	if (!fileItem) {
		return undefined;
	}
	let item = fileItem.children.get(name);
	if (!item) {
		item = controller.createTestItem(name, name, fileItem.uri);
		fileItem.children.add(item);
	}
	return item;
}

function toLocation(location: ReportLocation): Location {
	return new Location(Uri.file(location.file), new Position(location.row - 1, location.column - 1));
}

//#endregion Ausführen
