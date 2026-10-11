/**
 * ONNX rotary tables are indexed by position id. A prompt of length
 * `maxPositionEmbeddings` uses ids `0 .. maxPositionEmbeddings - 1`, and each
 * generated token takes the next id. Callers must leave `maxNewTokens` ids free
 * or the Gather node rejects the first id past the table (`idx=32768` on the
 * Qwen2.5 1.5B export, whose tokenizer `model_max_length` is 131072).
 */
export function onnxSafePromptTokens(maxPositionEmbeddings: number, maxNewTokens: number): number {
	if (!Number.isFinite(maxPositionEmbeddings) || maxPositionEmbeddings <= 1) return 1;
	const positions = Math.floor(maxPositionEmbeddings);
	const reserve = Number.isFinite(maxNewTokens) ? Math.max(1, Math.floor(maxNewTokens)) : 1;
	return Math.max(1, positions - reserve);
}

/** Keep the tail of `ids` so the latest turn survives a position-table cap. */
export function tailTokenIds(ids: readonly number[], limit: number): number[] {
	if (limit < 1 || ids.length <= limit) return ids.slice();
	return ids.slice(ids.length - limit);
}
