import {Component, type ReactNode} from 'react';
function previewErrorText(error: unknown) {
  const raw=error instanceof Error?error.message:String(error);
  return raw.replace(/(?:data:|(?:file|https?):\/\/)[^\s"'<>]+/gi,'[resource]').slice(0,2000)||'Preview rendering failed.';
}

/** An authored preview must never unmount the editor or its saved draft. */
export class DraftPreviewBoundary extends Component<{children: ReactNode; onError?: (message: string) => void}, {message: string}> {
  state = {message: ''};
  static getDerivedStateFromError(error: unknown) {
    return {message: previewErrorText(error)};
  }
  componentDidCatch(error: Error) {this.props.onError?.(previewErrorText(error));}
  render() {
    if (!this.state.message) return this.props.children;
    return <section className="assistant-preview-failure" role="alert"><h3>Preview needs a correction</h3><p>{this.state.message}</p><p>Your saved draft is intact. Undo the last edit or ask the Assistant to repair this preview.</p></section>;
  }
}
