import {createContext} from 'react';
import type {PresentationPackage} from '../presentation/schema';

/** Lightweight room entry point. Importing this context starts no provider,
 * worker, inference, or capture. The room lazily mounts its one owner. */
export interface AssistantSetRequest {
  document: PresentationPackage;
  onLoad: (document: PresentationPackage) => Promise<void>;
}
export interface AssistantEditorRequest {id: string; document: PresentationPackage}
export const RoomAssistantContext = createContext<{open(request: AssistantSetRequest): void} | null>(null);
