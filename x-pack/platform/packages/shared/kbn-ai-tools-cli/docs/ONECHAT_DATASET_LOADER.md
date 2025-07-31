# OneChat Dataset Loader

This document explains how to use the HuggingFace dataset loader to load OneChat datasets into Elasticsearch.

## Overview

The OneChat dataset loader extends the existing HuggingFace dataset loader to support dynamic loading of datasets from the `elastic/OneChatAgent` repository. OneChat datasets are stored as CSV files with their mappings defined in a central `index-mappings.jsonl` file.

## Prerequisites

1. **HuggingFace Access Token**: You need a HuggingFace access token to access the OneChat repository.

   ```bash
   export HUGGING_FACE_ACCESS_TOKEN="your_token_here"
   ```

2. **Elasticsearch/Kibana**: A running Elasticsearch cluster that the loader can connect to.

## Repository Structure

The OneChat datasets are stored in the `elastic/OneChatAgent` repository with the following structure:

```text
elastic/OneChatAgent/
├── knowledge-base/
│   ├── index-mappings.jsonl      # Dataset definitions and mappings for knowledge-base
│   └── datasets/
│       ├── wix_knowledge_base.csv # Example dataset
│       └── ...                   # Other datasets
├── users/
│   ├── index-mappings.jsonl      # Dataset definitions and mappings for users
│   └── datasets/
│       ├── user_profiles.csv     # Example dataset
│       └── ...                   # Other datasets
└── ...                           # Other categories
```

### index-mappings.jsonl Format

Each category directory contains its own `index-mappings.jsonl` file with dataset definitions for that category. Each line contains a JSON object defining a dataset:

```json
{
  "name": "wix_knowledge_base",
  "mappings": {
    "_meta": {
      "description": "Knowledge base articles and documentation for Wix platform."
    },
    "properties": {
      "id": {
        "type": "keyword",
        "meta": {
          "description": "Unique article identifier."
        }
      },
      "title": {
        "type": "text",
        "meta": {
          "description": "Article title."
        }
      }
    }
  }
}
```

## Usage

### Basic Usage

To load a single OneChat dataset:

```bash
node --require ./src/setup_node_env/index.js x-pack/platform/packages/shared/kbn-ai-tools-cli/scripts/hf_dataset_loader.ts --datasets onechat/knowledge-base/wix_knowledge_base
```

### Load Multiple Datasets

To load multiple OneChat datasets:

```bash
node --require ./src/setup_node_env/index.js x-pack/platform/packages/shared/kbn-ai-tools-cli/scripts/hf_dataset_loader.ts --datasets onechat/knowledge-base/wix_knowledge_base,onechat/users/user_profiles
```

### Mix OneChat and Regular Datasets

You can mix OneChat datasets with regular HuggingFace datasets:

```bash
node --require ./src/setup_node_env/index.js x-pack/platform/packages/shared/kbn-ai-tools-cli/scripts/hf_dataset_loader.ts --datasets onechat/knowledge-base/wix_knowledge_base,beir-msmarco
```

### Additional Options

- **Limit rows**: `--limit 500` (loads only first 500 rows)
- **Clear existing data**: `--clear` (removes existing indices before loading)
- **Custom Kibana URL**: `--kibana-url http://localhost:5601`

```bash
node --require ./src/setup_node_env/index.js x-pack/platform/packages/shared/kbn-ai-tools-cli/scripts/hf_dataset_loader.ts --datasets onechat/knowledge-base/wix_knowledge_base --limit 1000 --clear --kibana-url http://localhost:5601
```

## Dataset Naming Convention

OneChat datasets use the format `onechat/<directory>/<dataset>`:

- Repository file: `knowledge-base/datasets/wix_knowledge_base.csv`
- Loader dataset name: `onechat/knowledge-base/wix_knowledge_base`
- Elasticsearch index: `onechat-knowledge-base-wix_knowledge_base`

## Available Datasets

To see all available datasets (both OneChat and regular HuggingFace), run the loader without specifying datasets:

```bash
node --require ./src/setup_node_env/index.js x-pack/platform/packages/shared/kbn-ai-tools-cli/scripts/hf_dataset_loader.ts --kibana-url http://localhost:5601
```

This will display:

- All available regular HuggingFace datasets (beir-\*, huffpost, etc.)
- All available OneChat datasets from all categories
- Usage instructions

**Note**: This command will only list datasets and will not load anything into Elasticsearch.

## How It Works

1. **Dynamic Discovery**: The loader fetches `<directory>/index-mappings.jsonl` from the OneChat repository
2. **Mapping Resolution**: It finds the mapping definition for the requested dataset in the specified directory
3. **CSV Download**: Downloads the corresponding CSV file from the `<directory>/datasets/` folder
4. **CSV Parsing**: Converts CSV data to JSON objects
5. **Index Creation**: Creates Elasticsearch index with the defined mappings
6. **Data Loading**: Loads the processed data into Elasticsearch

## Error Handling

Common errors and solutions:

- **Dataset not found**: Ensure the dataset name exists in the appropriate directory's `index-mappings.jsonl`
- **Access token missing**: Set the `HUGGING_FACE_ACCESS_TOKEN` environment variable
- **File not found**: Verify the CSV file exists in the `<directory>/datasets/` folder
- **Invalid format**: Ensure you're using the correct format: `onechat/<directory>/<dataset>`
- **Elasticsearch connection**: Check your Elasticsearch/Kibana connectivity

## Examples

### Load knowledge base data

```bash
node --require ./src/setup_node_env/index.js x-pack/platform/packages/shared/kbn-ai-tools-cli/scripts/hf_dataset_loader.ts --datasets onechat/knowledge-base/wix_knowledge_base --limit 100
```

### Load knowledge base with clearing existing data

```bash
node --require ./src/setup_node_env/index.js x-pack/platform/packages/shared/kbn-ai-tools-cli/scripts/hf_dataset_loader.ts --datasets onechat/knowledge-base/wix_knowledge_base --clear
```

### Load multiple datasets for testing

```bash
node --require ./src/setup_node_env/index.js x-pack/platform/packages/shared/kbn-ai-tools-cli/scripts/hf_dataset_loader.ts --datasets onechat/knowledge-base/wix_knowledge_base,onechat/users/user_profiles --limit 10 --clear
```
