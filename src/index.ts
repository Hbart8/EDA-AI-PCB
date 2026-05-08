import * as extensionConfig from '../extension.json';

export function activate(status?: 'onStartupFinished', arg?: string): void {}

export function openStudio(): void {
	eda.sys_IFrame.openIFrame('/iframe/index.html', 560, 780);
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		`EDA AI Circuit v${extensionConfig.version}\n\n通过自然语言生成电路方案，并自动创建基础原理图。`,
		'About',
	);
}
