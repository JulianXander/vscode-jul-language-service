import { join } from 'path';
import {
	workspace,
	ExtensionContext,
	SemanticTokensLegend,
	DocumentSemanticTokensProvider,
	TextDocument,
	ProviderResult,
	SemanticTokens,
	SemanticTokensBuilder,
	Position,
	Range,
	languages,
	TextDocumentContentProvider,
} from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

//#region semantic highlighting
// const tokenTypes = ['function', 'parameter', 'type', 'variable'];
// const tokenModifiers = ['declaration'];
// const legend = new SemanticTokensLegend(tokenTypes, tokenModifiers);

// const provider: DocumentSemanticTokensProvider = {
// 	provideDocumentSemanticTokens(
// 		document: TextDocument
// 	): ProviderResult<SemanticTokens> {
// 		console.log('providing document tokens')
// 		// TODO
// 		const tokensBuilder = new SemanticTokensBuilder(legend);
// 		// on line 1, characters 1-5 are a class declaration
// 		tokensBuilder.push(
// 			new Range(new Position(1, 1), new Position(1, 5)),
// 			'class',
// 			['declaration']
// 		);
// 		return tokensBuilder.build();
// 	}
// };

// languages.registerDocumentSemanticTokensProvider({ language: 'jul', scheme: 'file' }, provider, legend);
//#endregion semantic highlighting

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

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'jul' }],
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
	const coreLibScheme = 'jul-core-lib';
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
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
