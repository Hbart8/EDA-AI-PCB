(function () {
	const STORAGE_KEYS = {
		apiKey: 'edaAiCircuit.apiKey',
		apiMode: 'edaAiCircuit.apiMode',
		chatUrl: 'edaAiCircuit.chatUrl',
		chatModel: 'edaAiCircuit.chatModel',
		boardName: 'edaAiCircuit.boardName',
		request: 'edaAiCircuit.request',
		planJson: 'edaAiCircuit.planJson',
	};

	const PLAN_SYSTEM_PROMPT =
		'你是电子电路设计助手。请把用户需求转换成严格 JSON，不要输出 markdown，不要解释。JSON schema: {"title":string,"summary":string,"blocks":[{"name":string,"x":number,"y":number,"width":number,"height":number}],"components":[{"ref":string,"name":string,"value":string,"searchKeywords":[string],"x":number,"y":number,"rotation":number,"addIntoPcb":boolean,"notes":string}],"wires":[{"net":string,"points":[[number,number],[number,number],[number,number]]}],"powerFlags":[{"identification":"Power"|"Ground"|"AnalogGround"|"ProtectGround","net":string,"x":number,"y":number,"rotation":number}],"textNotes":[{"content":string,"x":number,"y":number}],"nextPcbSuggestion":string}. 规则：1. 坐标单位按原理图常用网格整数输出即可。2. components 只输出基础常见器件，searchKeywords 用于库检索。3. wires 只输出主干基础连线。4. 如果需求不完整，也要给出可实现的最小方案。';

	const elements = {
		apiKey: document.getElementById('api-key'),
		apiMode: document.getElementById('api-mode'),
		chatUrl: document.getElementById('chat-url'),
		chatModel: document.getElementById('chat-model'),
		boardName: document.getElementById('board-name'),
		request: document.getElementById('request'),
		planJson: document.getElementById('plan-json'),
		planCircuit: document.getElementById('plan-circuit'),
		buildSchematic: document.getElementById('build-schematic'),
		statusLog: document.getElementById('status-log'),
	};

	const state = {
		isBusy: false,
	};

	function readConfig(key, fallback) {
		try {
			const value = eda.sys_Storage.getExtensionUserConfig(key);
			return value === undefined || value === null || value === '' ? fallback : value;
		}
		catch (error) {
			console.warn('Read config failed:', key, error);
			return fallback;
		}
	}

	function writeConfig(key, value) {
		try {
			eda.sys_Storage.setExtensionUserConfig(key, String(value));
		}
		catch (error) {
			console.warn('Write config failed:', key, error);
		}
	}

	function appendLog(message, type) {
		const item = document.createElement('div');
		item.className = `log-item ${type || 'info'}`;
		item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
		elements.statusLog.prepend(item);
	}

	function setBusy(nextBusy) {
		state.isBusy = nextBusy;
		elements.planCircuit.disabled = nextBusy;
		elements.buildSchematic.disabled = nextBusy;
	}

	function bindAutoSave(element, key) {
		element.addEventListener('input', () => {
			writeConfig(key, element.value);
		});
		element.addEventListener('change', () => {
			writeConfig(key, element.value);
		});
	}

	function loadSettings() {
		elements.apiKey.value = readConfig(STORAGE_KEYS.apiKey, '');
		elements.apiMode.value = readConfig(STORAGE_KEYS.apiMode, 'auto');
		elements.chatUrl.value = readConfig(STORAGE_KEYS.chatUrl, '');
		elements.chatModel.value = readConfig(STORAGE_KEYS.chatModel, '');
		elements.boardName.value = readConfig(STORAGE_KEYS.boardName, 'AI Board');
		elements.request.value = readConfig(STORAGE_KEYS.request, '');
		elements.planJson.value = readConfig(STORAGE_KEYS.planJson, '');
	}

	function bindAllAutosave() {
		bindAutoSave(elements.apiKey, STORAGE_KEYS.apiKey);
		bindAutoSave(elements.apiMode, STORAGE_KEYS.apiMode);
		bindAutoSave(elements.chatUrl, STORAGE_KEYS.chatUrl);
		bindAutoSave(elements.chatModel, STORAGE_KEYS.chatModel);
		bindAutoSave(elements.boardName, STORAGE_KEYS.boardName);
		bindAutoSave(elements.request, STORAGE_KEYS.request);
		bindAutoSave(elements.planJson, STORAGE_KEYS.planJson);
	}

	function getAuthHeaders() {
		const apiKey = elements.apiKey.value.trim();
		if (!apiKey) {
			throw new Error('请先填写 API Key。');
		}

		return {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		};
	}

	function detectApiMode(url) {
		const manualMode = elements.apiMode.value;
		if (manualMode && manualMode !== 'auto') {
			return manualMode;
		}

		if (/\/responses(?:\?|$|\/)/i.test(url)) {
			return 'responses';
		}

		return 'chat_completions';
	}

	function normalizeApiUrl(rawUrl, mode) {
		const url = String(rawUrl || '').trim().replace(/\/+$/, '');
		if (!url) {
			return url;
		}

		if (/\/chat\/completions$/i.test(url) || /\/responses$/i.test(url)) {
			return url;
		}

		if (/\/v1$/i.test(url)) {
			return `${url}/${mode === 'responses' ? 'responses' : 'chat/completions'}`;
		}

		return url;
	}

	function isHtmlResponse(text) {
		if (typeof text !== 'string') {
			return false;
		}

		const trimmed = text.trim().toLowerCase();
		return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || trimmed.startsWith('<head') || trimmed.startsWith('<body');
	}

	function buildHtmlResponseHint(url, mode) {
		return `接口返回的是 HTML 页面，不是 JSON。当前模式：${mode}。这通常说明请求没有正确进入 API 返回链路，而是被网关、登录页或错误页接管了。URL：${url}`;
	}

	async function ensureOkResponse(response, mode, url) {
		if (response.ok) {
			return;
		}

		const bodyText = await response.text();
		let reason = bodyText || `HTTP ${response.status}`;

		if (isHtmlResponse(bodyText)) {
			reason = buildHtmlResponseHint(url, mode);
		}
		else {
			try {
				const bodyJson = JSON.parse(bodyText);
				reason = bodyJson.error?.message || bodyJson.message || JSON.stringify(bodyJson).slice(0, 400) || reason;
			}
			catch (error) {
				console.warn('Response is not JSON:', error);
				reason = String(reason).slice(0, 400);
			}
		}

		throw new Error(`请求失败：HTTP ${response.status} ${reason}`);
	}

	async function parseJsonResponse(response, mode, url) {
		const rawText = await response.text();
		if (isHtmlResponse(rawText)) {
			throw new Error(buildHtmlResponseHint(url, mode));
		}

		try {
			return JSON.parse(rawText);
		}
		catch (error) {
			throw new Error(`接口返回的不是合法 JSON。当前模式：${mode}。URL：${url}。原始返回前 180 字符：${rawText.slice(0, 180)}`);
		}
	}

	function stripCodeFences(text) {
		return text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
	}

	function parsePlanJson(text) {
		const cleaned = stripCodeFences(text);
		try {
			return JSON.parse(cleaned);
		}
		catch (error) {
			const start = cleaned.indexOf('{');
			const end = cleaned.lastIndexOf('}');
			if (start >= 0 && end > start) {
				return JSON.parse(cleaned.slice(start, end + 1));
			}
			throw new Error(`AI 返回的 JSON 无法解析：${error.message || error}`);
		}
	}

	function extractResponsesText(payload) {
		if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
			return payload.output_text;
		}

		if (Array.isArray(payload?.output)) {
			const texts = [];
			for (const item of payload.output) {
				if (!Array.isArray(item?.content)) {
					continue;
				}
				for (const content of item.content) {
					if (content?.type === 'output_text' && typeof content.text === 'string') {
						texts.push(content.text);
					}
				}
			}
			if (texts.length > 0) {
				return texts.join('\n');
			}
		}

		if (payload?.content?.[0]?.text) {
			return payload.content[0].text;
		}

		throw new Error('Responses 接口返回成功，但没有找到可解析的文本输出。');
	}

	async function requestChatCompletion(messages) {
		const rawChatUrl = elements.chatUrl.value.trim();
		const chatModel = elements.chatModel.value.trim();

		if (!rawChatUrl || !chatModel) {
			throw new Error('请先填写聊天模型 API URL 和模型名称。');
		}

		let mode = detectApiMode(rawChatUrl);
		if (mode === 'chat_completions' && elements.apiMode.value === 'auto' && /\/v1$/i.test(rawChatUrl)) {
			mode = 'responses';
		}

		const chatUrl = normalizeApiUrl(rawChatUrl, mode);
		if (chatUrl !== rawChatUrl) {
			appendLog(`已自动补全接口地址：${chatUrl}`, 'info');
		}

		appendLog(`正在调用 ${mode === 'responses' ? 'Responses' : 'Chat Completions'} 接口...`, 'info');

		let requestBody;
		if (mode === 'responses') {
			const systemMessage = messages.find((message) => message.role === 'system')?.content || '';
			const userMessage = messages.filter((message) => message.role !== 'system').map((message) => message.content).join('\n\n');
			requestBody = {
				model: chatModel,
				instructions: String(systemMessage),
				input: String(userMessage),
				text: {
					format: {
						type: 'text',
					},
				},
			};
		}
		else {
			requestBody = {
				model: chatModel,
				temperature: 0.2,
				messages,
			};
		}

		const response = await eda.sys_ClientUrl.request(chatUrl, 'POST', JSON.stringify(requestBody), { headers: getAuthHeaders() });
		await ensureOkResponse(response, mode, chatUrl);

		const payload = await parseJsonResponse(response, mode, chatUrl);
		if (mode === 'responses') {
			return extractResponsesText(payload);
		}

		const content = payload?.choices?.[0]?.message?.content;
		if (!content) {
			throw new Error('Chat Completions 接口没有返回可用内容。');
		}

		return typeof content === 'string' ? content : JSON.stringify(content);
	}

	async function planCircuit() {
		const requestText = elements.request.value.trim();
		if (!requestText) {
			throw new Error('请先输入电路需求。');
		}

		appendLog('正在让 AI 生成电路方案...', 'info');
		const result = await requestChatCompletion([
			{
				role: 'system',
				content: PLAN_SYSTEM_PROMPT,
			},
			{
				role: 'user',
				content: requestText,
			},
		]);

		const plan = parsePlanJson(result);
		elements.planJson.value = JSON.stringify(plan, null, 2);
		writeConfig(STORAGE_KEYS.planJson, elements.planJson.value);
		appendLog('电路方案已生成。请先检查 JSON，再点“创建基础原理图”。', 'success');
	}

	async function createBlockFrames(plan) {
		if (!Array.isArray(plan.blocks) || !eda.sch_PrimitiveRectangle || !eda.sch_PrimitiveText) {
			return;
		}

		for (const block of plan.blocks) {
			await eda.sch_PrimitiveRectangle.create(
				Number(block.x || 0),
				Number(block.y || 0),
				Number(block.width || 200),
				Number(block.height || 120),
				0,
				0,
				'#7CA393',
				null,
				1,
				null,
				null,
			);
			await eda.sch_PrimitiveText.create(Number(block.x || 0) + 4, Number(block.y || 0) - 8, String(block.name || 'Block'));
		}
	}

	async function createNotes(plan) {
		if (!Array.isArray(plan.textNotes) || !eda.sch_PrimitiveText) {
			return;
		}

		for (const note of plan.textNotes) {
			await eda.sch_PrimitiveText.create(Number(note.x || 0), Number(note.y || 0), String(note.content || ''));
		}
	}

	async function createPowerFlags(plan) {
		if (!Array.isArray(plan.powerFlags) || !eda.sch_PrimitiveComponent?.createNetFlag) {
			return;
		}

		for (const flag of plan.powerFlags) {
			await eda.sch_PrimitiveComponent.createNetFlag(
				flag.identification || 'Power',
				String(flag.net || ''),
				Number(flag.x || 0),
				Number(flag.y || 0),
				Number(flag.rotation || 0),
				false,
			);
		}
	}

	async function createWires(plan) {
		if (!Array.isArray(plan.wires) || !eda.sch_PrimitiveWire) {
			return;
		}

		for (const wire of plan.wires) {
			if (!Array.isArray(wire.points) || wire.points.length < 2) {
				continue;
			}

			const line = wire.points.map((point) => [Number(point[0] || 0), Number(point[1] || 0)]);
			await eda.sch_PrimitiveWire.create(line, wire.net ? String(wire.net) : undefined, null, null, null);
		}
	}

	async function searchAndPlaceComponents(plan) {
		if (!Array.isArray(plan.components)) {
			return;
		}

		if (!eda.lib_Device || !eda.sch_PrimitiveComponent?.create) {
			throw new Error('当前环境不支持自动放置原理图器件。');
		}

		for (const component of plan.components) {
			const keywords = Array.isArray(component.searchKeywords) ? component.searchKeywords : [];
			const query = keywords[0] || component.name || component.value || component.ref;
			if (!query) {
				appendLog(`跳过未提供检索关键词的器件 ${component.ref || 'Unknown'}`, 'error');
				continue;
			}

			const results = await eda.lib_Device.search(String(query), undefined, undefined, undefined, 10, 1);
			if (!results || results.length === 0) {
				appendLog(`没有在库里找到器件：${component.ref || query}，关键词：${query}`, 'error');
				continue;
			}

			const chosen = results[0];
			const primitive = await eda.sch_PrimitiveComponent.create(
				chosen,
				Number(component.x || 0),
				Number(component.y || 0),
				undefined,
				Number(component.rotation || 0),
				false,
				true,
				component.addIntoPcb !== false,
			);

			if (!primitive) {
				appendLog(`器件放置失败：${component.ref || chosen.name}`, 'error');
				continue;
			}

			if (primitive.setState_Designator) {
				primitive.setState_Designator(component.ref ? String(component.ref) : undefined);
			}
			if (primitive.setState_Name) {
				primitive.setState_Name(component.value ? String(component.value) : undefined);
			}
			if (primitive.done) {
				await primitive.done();
			}

			appendLog(`已放置器件 ${component.ref || chosen.name}，检索关键词：${query}`, 'success');
		}
	}

	async function resolveTargetSchematicPage(boardName) {
		try {
			const schematicUuid = await eda.dmt_Schematic.createSchematic(boardName);
			if (schematicUuid) {
				const pageUuid = await eda.dmt_Schematic.createSchematicPage(schematicUuid);
				if (pageUuid) {
					try {
						await eda.dmt_Board.createBoard(schematicUuid);
					}
					catch (error) {
						console.warn('createBoard failed:', error);
						appendLog('关联板子创建失败，先继续生成原理图。', 'error');
					}

					await eda.dmt_EditorControl.openDocument(pageUuid);
					appendLog('已新建原理图和关联板子。', 'success');
					return { pageUuid, createdNewSchematic: true };
				}
			}
		}
		catch (error) {
			console.warn('create schematic flow failed:', error);
		}

		appendLog('新建原理图失败，正在回退到当前已打开的原理图页。', 'error');
		const currentPageInfo = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
		if (currentPageInfo?.uuid) {
			try {
				await eda.dmt_EditorControl.openDocument(currentPageInfo.uuid);
			}
			catch (error) {
				console.warn('open current schematic page failed:', error);
			}

			appendLog('已切换到当前原理图页，后续内容将生成到这里。', 'info');
			return { pageUuid: currentPageInfo.uuid, createdNewSchematic: false };
		}

		throw new Error('新建原理图失败，并且当前没有可用的原理图页。请先手动打开一个原理图页再试。');
	}

	async function buildSchematic() {
		if (!elements.planJson.value.trim()) {
			throw new Error('请先生成电路方案。');
		}

		const plan = parsePlanJson(elements.planJson.value);
		const boardName = elements.boardName.value.trim() || 'AI Board';

		appendLog('正在新建原理图和关联板子...', 'info');
		const target = await resolveTargetSchematicPage(boardName);

		if (eda.sch_PrimitiveText) {
			await eda.sch_PrimitiveText.create(10, 10, String(plan.title || boardName));
			await eda.sch_PrimitiveText.create(10, 24, String(plan.summary || ''));
		}

		await createBlockFrames(plan);
		await createNotes(plan);
		await createPowerFlags(plan);
		await searchAndPlaceComponents(plan);
		await createWires(plan);

		if (eda.sch_Document?.save) {
			await eda.sch_Document.save();
		}

		appendLog(
			target.createdNewSchematic
				? '基础原理图已创建完成。你现在可以在嘉立创里继续微调，然后再转 PCB。'
				: '内容已生成到当前原理图页。你现在可以在嘉立创里继续微调，然后再转 PCB。',
			'success',
		);

		if (plan.nextPcbSuggestion) {
			appendLog(`PCB 下一步建议：${plan.nextPcbSuggestion}`, 'info');
		}
	}

	async function runTask(taskFn) {
		if (state.isBusy) {
			return;
		}

		setBusy(true);
		try {
			await taskFn();
		}
		catch (error) {
			const message = error?.message || String(error);
			appendLog(message, 'error');
			console.error(error);
		}
		finally {
			setBusy(false);
		}
	}

	function wireEvents() {
		elements.planCircuit.addEventListener('click', () => runTask(planCircuit));
		elements.buildSchematic.addEventListener('click', () => runTask(buildSchematic));
	}

	function boot() {
		loadSettings();
		bindAllAutosave();
		wireEvents();
		appendLog('EDA AI Circuit 已就绪。先输入需求，生成方案，再创建基础原理图。', 'info');
		appendLog('建议先从简单电路开始，比如稳压、按键、LED、电源输入。', 'info');
	}

	boot();
})();
