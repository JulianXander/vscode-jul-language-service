import { join } from 'path';
import {
	workspace,
	ExtensionContext,
	Position,
	Range,
	TextDocumentContentProvider,
	TextEditor,
	ThemeColor,
	window,
} from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';
import { registerTestExplorer } from './test-explorer.js';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
	const serverModule = context.asAbsolutePath(
		join('node_modules', 'jul-lsp-server', 'out', 'server.js')
	);
	const debugServerModule = context.asAbsolutePath(
		join('..', 'jul-language-server', 'out', 'server.js')
	);

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: debugServerModule,
			transport: TransportKind.ipc,
			// --inspect=9229: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
			options: { execArgv: ['--nolazy', '--inspect=9229'] }
		}
	};

	// Scheme des read only virtual document für die core-lib, siehe unten
	const coreLibScheme = 'jul-core-lib';

	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: 'file', language: 'jul' },
			// auch das virtual document an den Server synchronisieren,
			// sonst funktionieren darin weder hover noch go to definition
			{ scheme: coreLibScheme, language: 'jul' },
		],
		synchronize: {
			// Notify the server about file changes to code files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/*.{js,json,jul,ts,yaml}')
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'julLanguageService',
		'JUL Language Service',
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start();

	//#region core-lib virtual document
	// Die core-lib wird als read only virtual document geöffnet, damit go to definition auf builtIns
	// nicht in der kompilierten Kopie unter out/ landet, die beim nächsten build überschrieben wird.
	// Der Inhalt kommt vom Server, da dessen core-lib Pfad je nach debug/Normalbetrieb variiert.
	const coreLibContentProvider: TextDocumentContentProvider = {
		provideTextDocumentContent: async () => {
			// idempotent, liefert das bestehende start Promise, falls der Server noch hochfährt
			await client.start();
			return client.sendRequest<string>('jul/coreLibContent');
		},
	};
	context.subscriptions.push(workspace.registerTextDocumentContentProvider(
		coreLibScheme,
		coreLibContentProvider));
	//#endregion core-lib virtual document

	registerEmptyLiteralDecoration(context);
	registerTestExplorer(context, client);
}

//#region empty literal decoration
// Die bracket pair colorization von VSCode wird nach der Tokenisierung auf die Klammerzeichen
// gelegt und übermalt damit jede Farbe aus Grammatik oder Semantic Tokens. Eine Decoration liegt
// darüber und ist deshalb der einzige Weg, [] als eigenen Wert erkennbar zu machen.
// Der Server schickt die Positionen nach jedem Neuparsen ungefragt. Eine Anfrage von hier müsste
// beim Server ausstehende Änderungen sofort verarbeiten und würde dessen Zusammenfassen beim Tippen
// aushebeln.
type EmptyLiteralsParams = {
	uri: string;
	version: number;
	ranges: {
		start: { line: number; character: number; };
		end: { line: number; character: number; };
	}[];
};

function registerEmptyLiteralDecoration(context: ExtensionContext): void {
	const decorationType = window.createTextEditorDecorationType({
		color: new ThemeColor('jul.emptyLiteralForeground'),
	});
	context.subscriptions.push(decorationType);
	// je Dokument der letzte Stand, für Editoren, die ohne Änderung sichtbar werden
	const latestByUri = new Map<string, EmptyLiteralsParams>();

	function apply(editor: TextEditor): void {
		const emptyLiterals = latestByUri.get(editor.document.uri.toString());
		// Positionen einer älteren Version passen nicht mehr. Die bisherigen Decorations bleiben
		// stehen, VSCode verschiebt sie beim Tippen mit, und nach dem Verarbeiten kommt der neue Stand.
		if (emptyLiterals?.version !== editor.document.version) {
			return;
		}
		editor.setDecorations(decorationType, emptyLiterals.ranges.map(range => new Range(
			new Position(range.start.line, range.start.character),
			new Position(range.end.line, range.end.character))));
	}

	context.subscriptions.push(
		client.onNotification('jul/emptyLiterals', (emptyLiterals: EmptyLiteralsParams) => {
			latestByUri.set(emptyLiterals.uri, emptyLiterals);
			window.visibleTextEditors
				.filter(editor => editor.document.uri.toString() === emptyLiterals.uri)
				.forEach(apply);
		}),
		window.onDidChangeVisibleTextEditors(editors => editors.forEach(apply)),
		workspace.onDidCloseTextDocument(document => latestByUri.delete(document.uri.toString())));
}
//#endregion empty literal decoration

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
