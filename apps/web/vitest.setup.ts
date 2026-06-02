// Vitest setup — глушит `server-only` (он бросает в client-bundle, а Vitest = Node).
import { vi } from 'vitest';

vi.mock('server-only', () => ({}));
