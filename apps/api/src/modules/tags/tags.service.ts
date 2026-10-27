import type { CreateTagInput, Tag, UpdateTagRequest } from '@pulsedesk/shared';
import type { RequestMeta, TenantContext } from '../../http/auth-context.ts';
import { ConflictError, NotFoundError } from '../../http/errors.ts';
import type { Clock } from '../../lib/clock.ts';
import {
  TagNameTakenError,
  type ScopedTagsRepository,
  type TagRow,
  type TagsRepository,
} from './tags.repository.ts';

function toDto(row: TagRow): Tag {
  return { id: row.id, name: row.name, color: row.color, ticketCount: row._count.tickets };
}

/**
 * Tags of the active organization. Everyone who works tickets can list them; creating,
 * renaming, recoloring and deleting needs `tag:manage`. A tag ID from another organization
 * is not found (404), exactly like one that never existed.
 */
export function createTagsService({
  repository,
  clock,
}: {
  repository: TagsRepository;
  clock: Clock;
}) {
  async function write<T>(
    tenant: TenantContext,
    meta: RequestMeta,
    fn: (tags: ScopedTagsRepository) => Promise<T>,
  ): Promise<T> {
    try {
      return await repository.serialized(
        tenant.organizationId,
        { actorUserId: tenant.userId, ipAddress: meta.ipAddress, requestId: tenant.requestId },
        fn,
      );
    } catch (error) {
      if (error instanceof TagNameTakenError) {
        throw new ConflictError('A tag with this name already exists in this organization.');
      }
      throw error;
    }
  }

  async function existing(tags: ScopedTagsRepository, tagId: string): Promise<TagRow> {
    const tag = await tags.find(tagId);
    if (!tag) throw new NotFoundError('Tag');
    return tag;
  }

  return {
    async list(tenant: TenantContext): Promise<Tag[]> {
      return (await repository.list(tenant.organizationId)).map(toDto);
    },

    create(tenant: TenantContext, input: CreateTagInput, meta: RequestMeta): Promise<Tag> {
      return write(tenant, meta, async (tags) => {
        await tags.assertNameFree(input.name);
        return toDto(await tags.create(input.name, input.color));
      });
    },

    update(
      tenant: TenantContext,
      tagId: string,
      input: UpdateTagRequest,
      meta: RequestMeta,
    ): Promise<Tag> {
      return write(tenant, meta, async (tags) => {
        const tag = await existing(tags, tagId);
        // Changing only the case of a tag's own name is allowed.
        if (input.name !== undefined) await tags.assertNameFree(input.name, tag.id);
        return toDto(await tags.update(tag, input));
      });
    },

    remove(tenant: TenantContext, tagId: string, meta: RequestMeta): Promise<void> {
      return write(tenant, meta, async (tags) => {
        await tags.delete(await existing(tags, tagId), clock.now());
      });
    },
  };
}

export type TagsService = ReturnType<typeof createTagsService>;
