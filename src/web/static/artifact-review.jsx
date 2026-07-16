/* Review-first multi-file artifact UI. Loaded before app.jsx as a Babel global. */
(function () {
  const { useEffect, useMemo, useRef, useState } = React;

  function bytesLabel(bytes) {
    if (bytes < 1024) return bytes + ' B';
    return (bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1) + ' KB';
  }

  function statusLabel(operation) {
    return operation === 'create' ? 'New' : operation === 'update' ? 'Modified' : 'Unchanged';
  }

  function contentFor(artifact, basePath, file) {
    const prefix = basePath ? basePath.replace(/\/+$/, '') + '/' : '';
    const candidate = (artifact.candidates || []).find((item) => prefix + item.path === file.path);
    return candidate ? candidate.content : '';
  }

  function ArtifactTurnCard({ artifact, receipt, onReview, onUndo }) {
    if (!artifact || !Array.isArray(artifact.candidates) || artifact.candidates.length === 0) return null;
    const count = artifact.candidates.length;
    const saved = receipt?.kind === 'applied';
    const undone = receipt?.kind === 'undone';
    const [undoing, setUndoing] = useState(false);
    const [undoError, setUndoError] = useState(null);
    async function undo() {
      if (!onUndo || undoing) return;
      setUndoing(true); setUndoError(null);
      try { await onUndo(); } catch (reason) { setUndoError(reason.message || 'Could not undo the saved files.'); }
      finally { setUndoing(false); }
    }
    return (
      <section className={'mm-artifact-turn-card' + (saved ? ' saved' : '') + (undone ? ' undone' : '')} aria-label="Generated files">
        <div className="mm-artifact-turn-icon" aria-hidden="true">{saved ? '✓' : '⌁'}</div>
        <div className="mm-artifact-turn-body">
          <strong>{saved ? 'Saved ' + receipt.count + ' files' : undone ? 'Saved files were undone' : 'Website ready to review'}</strong>
          <span>{count} proposed {count === 1 ? 'file' : 'files'} · {artifact.projectName || 'selected project'}</span>
          {undoError && <span className="mm-artifact-card-error" role="alert">{undoError}</span>}
        </div>
        {!saved && !undone && <button type="button" className="mm-artifact-review-btn" onClick={onReview}>Review and save</button>}
        {saved && <button type="button" className="mm-artifact-review-btn" onClick={undo} disabled={undoing}>{undoing ? 'Undoing...' : 'Undo save'}</button>}
      </section>
    );
  }

  function ArtifactReviewDialog({ artifact, onClose, onApplied, mutate }) {
    const [phase, setPhase] = useState('idle');
    const [basePath, setBasePath] = useState('');
    const [proposal, setProposal] = useState(null);
    const [selected, setSelected] = useState(new Set());
    const [activeFileId, setActiveFileId] = useState(null);
    const [tab, setTab] = useState('changes');
    const [diff, setDiff] = useState(null);
    const [diffError, setDiffError] = useState(null);
    const [rootInfo, setRootInfo] = useState(null);
    const [error, setError] = useState(null);
    const panelRef = useRef(null);
    const closeRef = useRef(null);

    useEffect(() => {
      let live = true;
      fetch('/api/files/root')
        .then(async (response) => {
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || 'Could not read the active project');
          if (live) setRootInfo(body);
        })
        .catch((reason) => { if (live) setError(reason.message); });
      return () => { live = false; };
    }, []);

    useEffect(() => {
      const previous = document.activeElement;
      closeRef.current?.focus();
      const onKeyDown = (event) => {
        if (event.key === 'Escape' && phase !== 'applying') {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.key !== 'Tab' || !panelRef.current) return;
        const focusable = [...panelRef.current.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      };
      document.addEventListener('keydown', onKeyDown);
      return () => {
        document.removeEventListener('keydown', onKeyDown);
        if (previous instanceof HTMLElement) previous.focus();
      };
    }, [onClose, phase]);

    const activeFile = proposal?.files.find((file) => file.id === activeFileId) || null;
    const selectedCount = selected.size;
    const selectedBytes = proposal?.files.filter((file) => selected.has(file.id)).reduce((sum, file) => sum + file.bytes, 0) || 0;
    const destination = rootInfo?.root
      ? rootInfo.root + (basePath ? '/' + basePath.replace(/^\/+|\/+$/g, '') : '')
      : (artifact.projectName || 'selected project');

    useEffect(() => {
      if (!proposal || !activeFile || tab !== 'changes') return;
      let live = true;
      setDiff(null); setDiffError(null);
      fetch('/api/artifacts/proposals/' + encodeURIComponent(proposal.id) + '/files/' + encodeURIComponent(activeFile.id) + '/diff')
        .then(async (response) => {
          const body = await response.json();
          if (!response.ok) {
            const error = new Error(body.error || 'Could not load changes');
            error.code = body.code;
            throw error;
          }
          if (live) setDiff(body.diff);
        })
        .catch((reason) => { if (live) setDiffError(reason.message); });
      return () => { live = false; };
    }, [proposal?.id, activeFile?.id, tab]);

    async function prepare() {
      setPhase('validating'); setError(null);
      try {
        const response = await mutate('/api/artifacts/proposals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: artifact.projectId,
            sessionId: artifact.sessionId || 'web-session',
            sourceTurnId: artifact.sourceTurnId,
            title: 'Generated files',
            basePath: basePath.trim(),
            files: artifact.candidates,
          }),
        });
        const body = await response.json();
        if (!response.ok) {
          const failure = new Error(body.error || 'Could not prepare files');
          failure.code = body.code;
          throw failure;
        }
        const nextProposal = body.proposal;
        const defaults = new Set(nextProposal.files.filter((file) => file.operation !== 'unchanged').map((file) => file.id));
        setProposal(nextProposal);
        setSelected(defaults);
        setActiveFileId(nextProposal.files[0]?.id || null);
        setPhase('ready');
      } catch (reason) {
        setError(reason.message);
        setPhase(reason.code === 'PROJECT_CONTEXT_CHANGED' ? 'conflict' : 'error');
      }
    }

    function toggleFile(file) {
      if (file.operation === 'unchanged') return;
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(file.id)) next.delete(file.id); else next.add(file.id);
        return next;
      });
    }

    async function apply() {
      if (!proposal || selected.size === 0) return;
      setPhase('applying'); setError(null);
      try {
        const response = await mutate('/api/artifacts/proposals/' + encodeURIComponent(proposal.id) + '/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: artifact.projectId,
            projectRevision: artifact.projectRevision,
            fileIds: [...selected],
            confirm: true,
          }),
        });
        const body = await response.json();
        if (!response.ok) {
          const failure = new Error(body.error || 'Could not save selected files');
          failure.code = body.code;
          throw failure;
        }
        setPhase('complete');
        onApplied({
          kind: 'applied',
          count: body.appliedFileIds?.length || selected.size,
          transactionId: body.transactionId,
          undoToken: body.undoToken,
          undoExpiresAt: body.undoExpiresAt,
        });
      } catch (reason) {
        setError(reason.message);
        setPhase(reason.code === 'ARTIFACT_CONFLICT' || reason.code === 'PROJECT_CONTEXT_CHANGED' ? 'conflict' : 'error');
      }
    }

    function resetProposal() {
      setProposal(null); setSelected(new Set()); setActiveFileId(null); setDiff(null); setError(null); setPhase('idle');
    }

    return (
      <div className="mm-artifact-dialog-layer" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget && phase !== 'applying') onClose();
      }}>
        <section className="mm-artifact-dialog" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="artifact-review-title">
          <header className="mm-artifact-dialog-head">
            <div>
              <span className="mm-artifact-eyebrow">Review generated files</span>
              <h2 id="artifact-review-title">Save a complete file set</h2>
              <p>{artifact.projectName || 'Selected project'} · <code>{destination}</code></p>
            </div>
            <button ref={closeRef} type="button" className="mm-artifact-close" onClick={onClose} disabled={phase === 'applying'} aria-label="Close artifact review">×</button>
          </header>

          {(phase === 'idle' || phase === 'validating') && (
            <div className="mm-artifact-prepare">
              <p>The model proposed {artifact.candidates.length} files. Choose a folder under the captured project, then validate the complete batch before any disk changes.</p>
              <label>
                Destination folder under project <span>(optional)</span>
                <input value={basePath} onChange={(event) => setBasePath(event.target.value)} placeholder="e.g. portfolio-site" disabled={phase === 'validating'} />
              </label>
              {error && <div className="mm-artifact-error" role="alert">{error}</div>}
              <button type="button" className="mm-artifact-primary" onClick={prepare} disabled={phase === 'validating'}>
                {phase === 'validating' ? 'Validating files…' : 'Prepare review'}
              </button>
            </div>
          )}

          {(phase === 'ready' || phase === 'applying' || phase === 'complete' || phase === 'conflict' || phase === 'error') && proposal && (
            <>
              <div className="mm-artifact-workspace">
                <aside className="mm-artifact-file-list" aria-label="Proposed files">
                  {proposal.files.map((file) => (
                    <label key={file.id} className={'mm-artifact-file-row ' + (activeFileId === file.id ? 'active' : '')}>
                      <input type="checkbox" checked={selected.has(file.id)} onChange={() => toggleFile(file)} disabled={file.operation === 'unchanged' || phase === 'applying' || phase === 'complete'} />
                      <button type="button" onClick={() => setActiveFileId(file.id)} disabled={phase === 'applying'}>
                        <span className="mm-artifact-file-path">{file.path}</span>
                        <span><b className={'mm-artifact-status ' + file.operation}>{statusLabel(file.operation)}</b> {bytesLabel(file.bytes)}</span>
                      </button>
                    </label>
                  ))}
                </aside>
                <main className="mm-artifact-main">
                  <div className="mm-artifact-tabs" role="tablist" aria-label="Artifact file view">
                    {['changes', 'content', 'preview'].map((name) => (
                      <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>
                        {name[0].toUpperCase() + name.slice(1)}
                      </button>
                    ))}
                  </div>
                  <div className="mm-artifact-tabpanel" role="tabpanel">
                    {!activeFile ? <p>Select a file to inspect it.</p> : tab === 'changes' ? (
                      diffError ? <div className="mm-artifact-error" role="alert">{diffError}</div>
                        : diff === null ? <p aria-live="polite">Loading changes…</p>
                          : <pre className="mm-artifact-diff">{diff || 'No changes.'}</pre>
                    ) : tab === 'content' ? (
                      <pre className="mm-artifact-content">{contentFor(artifact, basePath.trim(), activeFile)}</pre>
                    ) : (
                      <ArtifactPreview artifact={artifact} />
                    )}
                  </div>
                </main>
              </div>
              {error && <div className="mm-artifact-error" role="alert">{error}</div>}
              {phase === 'conflict' && <div className="mm-artifact-conflict" role="alert">The project or one of these files changed. No selected files were saved. Recreate the proposal to revalidate it.</div>}
              {phase === 'complete' && <div className="mm-artifact-success" role="status">Saved {selectedCount} files to the shown destination.</div>}
              <footer className="mm-artifact-apply-bar">
                <span>{selectedCount} selected · {bytesLabel(selectedBytes)}</span>
                <div>
                  {phase === 'conflict' ? <button type="button" onClick={resetProposal}>Recreate review</button> : null}
                  <button type="button" onClick={onClose} disabled={phase === 'applying'}>{phase === 'complete' ? 'Done' : 'Cancel'}</button>
                  <button type="button" className="mm-artifact-primary" onClick={apply} disabled={phase !== 'ready' || selectedCount === 0}>
                    {phase === 'applying' ? 'Saving…' : 'Apply selected (' + selectedCount + ')'}
                  </button>
                </div>
              </footer>
            </>
          )}
        </section>
      </div>
    );
  }

  function ArtifactPreview({ artifact }) {
    const [viewport, setViewport] = useState('desktop');
    const preview = useMemo(() => window.ArtifactPreview?.buildPreviewDocument(artifact.candidates), [artifact]);
    if (!preview?.ok) return <div className="mm-artifact-preview-note">{preview?.error || 'Source preview is unavailable.'}</div>;
    return (
      <div className="mm-artifact-preview">
        <div className="mm-artifact-preview-controls" aria-label="Preview viewport">
          <span>Static source preview</span>
          {['desktop', 'mobile'].map((name) => <button key={name} type="button" aria-pressed={viewport === name} onClick={() => setViewport(name)}>{name}</button>)}
        </div>
        <p className="mm-artifact-preview-note">Runs in an isolated sandbox. Network, local project APIs and app storage are unavailable.</p>
        <div className={'mm-artifact-preview-shell ' + viewport}>
          <iframe title="Sandboxed source preview" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={preview.document} />
        </div>
      </div>
    );
  }

  window.ArtifactTurnCard = ArtifactTurnCard;
  window.ArtifactReviewDialog = ArtifactReviewDialog;
}());
