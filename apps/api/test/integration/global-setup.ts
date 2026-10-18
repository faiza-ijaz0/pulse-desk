import { resetTestDatabase } from '@pulsedesk/db/testing';

export default function setup(): void {
  resetTestDatabase();
}
