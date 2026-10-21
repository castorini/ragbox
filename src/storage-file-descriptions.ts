import { REQUIRED_MODEL_FILES } from './model-readiness.ts';
import { DEMO_FILES } from './reset.ts';

const storedFiles: Readonly<Record<string, string>> = {
  'analytics.duckdb': 'Stores NFCorpus articles and their search index.',
  'analytics.duckdb.wal': 'Keeps recent NFCorpus database changes until they are saved.',
  'analytics.duckdb.wal.checkpoint': 'Supports saving recent NFCorpus database changes.',
  'analytics.duckdb.wal.recovery': 'Helps recover NFCorpus database changes after an interruption.',
  'msmarco-prebuilt.duckdb': 'Downloaded MS MARCO passages and their search index.',
  'msmarco-prebuilt.duckdb.wal': 'Recovery log associated with the MS MARCO database.',
  'cache/monthly_totals.parquet': 'Legacy demo cache of monthly order totals.',
  'export/transactions.parquet': 'Legacy demo export of sample purchase transactions.',
} satisfies Record<(typeof DEMO_FILES)[number], string>;

export function describeStoredFile(path: string): string {
  return Object.hasOwn(storedFiles, path) ? storedFiles[path] : 'Purpose unknown; this file is not managed by RAGbox.';
}

const modelFiles: Readonly<Record<string, string>> = {
  'config.json': 'Describes the model architecture and how to load its weights.',
  'tokenizer.json': 'Converts text to model tokens and tokens back to text.',
  'tokenizer_config.json': 'Sets tokenizer options and the chat message format.',
  'generation_config.json': 'Stores default settings for generating answers.',
  'special_tokens_map.json': 'Identifies special tokens such as message boundaries and padding.',
  'added_tokens.json': 'Lists extra tokens added to the tokenizer’s vocabulary.',
  'vocab.json': 'Lists the text pieces recognized by the tokenizer.',
  'vocab.txt': 'Lists the text pieces recognized by the tokenizer.',
  'merges.txt': 'Tells the tokenizer how to combine text pieces into tokens.',
  'tokenizer.model': 'Stores the tokenizer’s rules and vocabulary for splitting text.',
  'spiece.model': 'Stores the tokenizer’s rules and vocabulary for splitting text.',
  'chat_template.jinja': 'Formats conversation messages before the model reads them.',
  'chat_template.json': 'Formats conversation messages before the model reads them.',
};
const weightFiles = REQUIRED_MODEL_FILES.filter(path => path.includes('.onnx_data'));

export function describeModelFile(path: string): string {
  // Cached paths may include resolve/<revision>/ or use the legacy local format.
  const name = path.split('/').at(-1) ?? path;
  const weightPart = weightFiles.findIndex(file => file.split('/').at(-1) === name);
  if (weightPart !== -1) return `Trained model weights, part ${weightPart + 1} of ${weightFiles.length}, used to generate answers.`;
  if (Object.hasOwn(modelFiles, name)) return modelFiles[name];
  if (name.endsWith('.onnx')) return 'Defines the neural network used to generate answers on your device.';
  if (/\.onnx_data(?:_\d+)?$/.test(name)) return 'Stores part of the model’s trained weights for generating answers.';
  return 'Additional cached file for the local answer model.';
}
