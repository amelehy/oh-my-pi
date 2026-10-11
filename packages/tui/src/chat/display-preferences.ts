/** Process-wide display preferences applied by the host settings hooks. */
export interface ChatTranscriptDisplayPreferences {
	hideToolActivity: boolean;
	readToolResultPreview: boolean;
	showImages: boolean;
	cacheMissMarker: boolean;
	showTokenUsage: boolean;
	showTurnTime: boolean;
	/** Box each turn's final answer so it stands apart from the steps above it. */
	answerFrame: boolean;
}

/** Current transcript display preferences. */
export const chatTranscriptDisplayPreferences: ChatTranscriptDisplayPreferences = {
	hideToolActivity: false,
	readToolResultPreview: false,
	showImages: true,
	cacheMissMarker: false,
	showTokenUsage: false,
	showTurnTime: false,
	answerFrame: false,
};

/** Apply host display preferences without pulling settings into the renderer. */
export function setChatTranscriptDisplayPreferences(preferences: Partial<ChatTranscriptDisplayPreferences>): void {
	Object.assign(chatTranscriptDisplayPreferences, preferences);
}
