import { type BaseLogger } from 'pino';
import { QdrantClient } from '@qdrant/qdrant-js';
import { AppConfig } from '../../plugins/config.js';
import { DocumentProcessor } from '../document-processor.js';
import { EmbeddingModel } from '../embedding-model.js';
import { FileInfos } from '../file.js';
import { type VectorDB } from './vector-db.js';

export class QdrantVectorDB implements VectorDB {
  private qdrantClient: QdrantClient;

  constructor(
    private logger: BaseLogger,
    private embeddingModel: EmbeddingModel,
    config: AppConfig,
  ) {
    this.qdrantClient = new QdrantClient({ url: config.qdrantUrl });
  }

  async addToIndex(indexName: string, fileInfos: FileInfos): Promise<void> {
    const { filename, data, type, category } = fileInfos;
    const documentProcessor = new DocumentProcessor(this.logger);
    const document = await documentProcessor.createDocumentFromFile(filename, data, type, category);
    const sections = document.sections;
    await this.embeddingModel.updateEmbeddingsInBatch(sections);

    const ids = sections.map((section) => section.id);
    const vectors = sections.map((section) => section.embedding!);
    const payloads = sections.map((section) => ({ 
      content: section.content,
      category: section.category,
      sourcepage: section.sourcepage,
      sourcefile: section.sourcefile,
    }));

    await this.qdrantClient.upsert(indexName, {
      batch: { ids, vectors, payloads }
    });
    this.logger.debug(`Indexed ${sections.length} sections from file "${filename}"`);
  }

  async deleteFromIndex(indexName: string, filename?: string): Promise<void> {
    await this.qdrantClient.delete(indexName, {
      filter: { 
        must: [
          { key: 'sourcefile', match: { value: filename } },
        ]
      }
    });
  }

  async ensureSearchIndex(indexName: string): Promise<void> {
    try {
      await this.qdrantClient.getCollection(indexName);
      this.logger.debug(`Search index "${indexName}" already exists`);
    } catch (_error: unknown) {
      const error = _error as Error;
      if (error.message === 'Collection not found') {
        this.logger.debug(`Creating search index "${indexName}"`);
        await this.qdrantClient.createCollection(indexName, {
          vectors: {
            size: this.embeddingModel.size,
            distance: 'Cosine',
          }
        });
      } else {
        throw error;
      }
    }
  }

  async deleteSearchIndex(indexName: string): Promise<void> {
    await this.qdrantClient.deleteCollection(indexName);
  }
}