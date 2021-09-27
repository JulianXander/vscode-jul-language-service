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
	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		join('out', 'language-server', 'out', 'language-server', 'src', 'server.js')
	);
	// The debug options for the server
	// --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
	const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: debugOptions
		}
	};

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		// documentSelector: [{ scheme: 'file', language: 'plaintext' }],
		// TODO
		documentSelector: [{ scheme: 'file', language: 'jul' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
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
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
