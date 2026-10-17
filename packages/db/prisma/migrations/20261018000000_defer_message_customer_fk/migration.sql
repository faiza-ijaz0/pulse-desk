-- Hand-written: Prisma's schema language cannot express deferrable constraints.
-- See docs/architecture/data-model.md (§4, "Message → Customer is deferred").
--
-- Deleting an Organization cascades to Customer (one level deep) and to Message via
-- Ticket (two levels deep). A NO ACTION check runs when the cascaded Customer delete
-- finishes, before the deeper Ticket → Message cascade has removed the messages, so the
-- organization delete failed with a spurious violation. Deferring the check to commit
-- lets the whole cascade complete, while a direct delete of a customer who still has
-- messages is still rejected (at commit).
ALTER TABLE "Message"
  ALTER CONSTRAINT "Message_organizationId_authorCustomerId_fkey" DEFERRABLE INITIALLY DEFERRED;
