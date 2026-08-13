import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const MIN_INLINE_WIDTH = 96;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function SvgIcon({ children, size = 16 }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function ExpandIcon() {
  return (
    <SvgIcon>
      <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5" />
      <path d="M3 8l6-6M21 8l-6-6M3 16l6 6M21 16l-6 6" />
    </SvgIcon>
  );
}

export function DownloadIcon() {
  return (
    <SvgIcon>
      <path d="M12 3v12M7 10l5 5 5-5" />
      <path d="M4 19h16" />
    </SvgIcon>
  );
}

export function CopyIcon() {
  return (
    <SvgIcon>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </SvgIcon>
  );
}

export function CheckIcon() {
  return (
    <SvgIcon>
      <path d="M5 12.5l4.2 4.2L19 7" />
    </SvgIcon>
  );
}

function ResizeIcon() {
  return (
    <SvgIcon size={14}>
      <path d="M21 13v8h-8M21 17l-4 4M21 9L9 21" />
    </SvgIcon>
  );
}

function ZoomOutIcon() {
  return (
    <SvgIcon>
      <circle cx="11" cy="11" r="7" />
      <path d="M8 11h6M16.5 16.5L21 21" />
    </SvgIcon>
  );
}

function ZoomInIcon() {
  return (
    <SvgIcon>
      <circle cx="11" cy="11" r="7" />
      <path d="M8 11h6M11 8v6M16.5 16.5L21 21" />
    </SvgIcon>
  );
}

function CloseIcon() {
  return (
    <SvgIcon size={18}>
      <path d="M5 5l14 14M19 5L5 19" />
    </SvgIcon>
  );
}

function AlignLeftIcon() {
  return (
    <SvgIcon>
      <path d="M4 6h10M4 10h16M4 14h12M4 18h16" />
    </SvgIcon>
  );
}

function AlignCenterIcon() {
  return (
    <SvgIcon>
      <path d="M7 6h10M4 10h16M6 14h12M4 18h16" />
    </SvgIcon>
  );
}

function AlignRightIcon() {
  return (
    <SvgIcon>
      <path d="M10 6h10M4 10h16M8 14h12M4 18h16" />
    </SvgIcon>
  );
}

const ALIGNMENT_OPTIONS = [
  { value: 'left', label: '左对齐', icon: <AlignLeftIcon /> },
  { value: 'center', label: '居中', icon: <AlignCenterIcon /> },
  { value: 'right', label: '右对齐', icon: <AlignRightIcon /> },
];

function AlignmentControls({ alignment, label, onChange }) {
  return (
    <span className="media-alignment-controls" role="group" aria-label={`${label}对齐方式`}>
      {ALIGNMENT_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="media-icon-button media-align-button"
          onClick={() => onChange(option.value)}
          aria-label={`${label}${option.label}`}
          aria-pressed={alignment === option.value}
          title={option.label}
        >
          {option.icon}
        </button>
      ))}
    </span>
  );
}

function MediaLightbox({
  alignment,
  alignable,
  children,
  label,
  onAlignmentChange,
  onClose,
  onDownload,
}) {
  const [zoom, setZoom] = useState(1);
  const closeButtonRef = useRef(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const toolbar = closeButtonRef.current?.parentElement;
      const controls = Array.from(toolbar?.querySelectorAll('button:not(:disabled)') || []);
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const setClampedZoom = (value) => {
    setZoom(clamp(value, MIN_ZOOM, MAX_ZOOM));
  };

  return createPortal(
    <div
      className="media-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`${label}放大视图`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="media-lightbox-toolbar" data-copy-ignore>
        {alignable && (
          <AlignmentControls
            alignment={alignment}
            label={label}
            onChange={onAlignmentChange}
          />
        )}
        {onDownload && (
          <button
            type="button"
            className="media-icon-button"
            onClick={onDownload}
            aria-label="下载 SVG"
            title="下载 SVG"
          >
            <DownloadIcon />
          </button>
        )}
        <button
          type="button"
          className="media-icon-button"
          onClick={() => setClampedZoom(zoom - ZOOM_STEP)}
          disabled={zoom <= MIN_ZOOM}
          aria-label="缩小"
          title="缩小"
        >
          <ZoomOutIcon />
        </button>
        <button
          type="button"
          className="media-zoom-reset"
          onClick={() => setZoom(1)}
          aria-label="恢复 100% 缩放"
          title="恢复 100% 缩放"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className="media-icon-button"
          onClick={() => setClampedZoom(zoom + ZOOM_STEP)}
          disabled={zoom >= MAX_ZOOM}
          aria-label="放大"
          title="放大"
        >
          <ZoomInIcon />
        </button>
        <button
          ref={closeButtonRef}
          type="button"
          className="media-icon-button"
          onClick={onClose}
          aria-label="关闭放大视图"
          title="关闭"
        >
          <CloseIcon />
        </button>
      </div>
      <div
        className="media-lightbox-viewport"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div
          className="media-lightbox-content"
          data-media-align={alignable ? alignment : undefined}
          style={{ width: `${zoom * 100}%` }}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 图表与图片共享的交互外框：右上角放大，右下角按比例拖拽。
 * 放大时把同一份内容移动到 portal，避免 Mermaid SVG 的 id 重复。
 */
export default function MediaFrame({
  alignable = false,
  alignment = 'center',
  children,
  className = '',
  label = '媒体内容',
  onAlignmentChange,
  onDownload,
  ...props
}) {
  const frameRef = useRef(null);
  const expandButtonRef = useRef(null);
  const resizeRef = useRef(null);
  const [inlineWidth, setInlineWidth] = useState(null);
  const [placeholderHeight, setPlaceholderHeight] = useState(0);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => () => {
    if (resizeRef.current) {
      window.removeEventListener('pointermove', resizeRef.current.move);
      window.removeEventListener('pointerup', resizeRef.current.end);
      window.removeEventListener('pointercancel', resizeRef.current.end);
    }
  }, []);

  const updateWidth = (nextWidth) => {
    const frame = frameRef.current;
    if (!frame) return;
    const parentWidth = frame.parentElement?.getBoundingClientRect().width
      || frame.getBoundingClientRect().width;
    setInlineWidth(clamp(nextWidth, MIN_INLINE_WIDTH, Math.max(MIN_INLINE_WIDTH, parentWidth)));
  };

  const startResize = (event) => {
    const frame = frameRef.current;
    if (!frame) return;
    event.preventDefault();
    const rect = frame.getBoundingClientRect();
    const aspectRatio = rect.height > 0 ? rect.width / rect.height : 1;
    const start = {
      x: event.clientX,
      y: event.clientY,
      width: rect.width,
      aspectRatio,
    };
    const move = (moveEvent) => {
      const deltaX = moveEvent.clientX - start.x;
      const deltaYAsWidth = (moveEvent.clientY - start.y) * start.aspectRatio;
      const delta = Math.abs(deltaX) >= Math.abs(deltaYAsWidth)
        ? deltaX
        : deltaYAsWidth;
      updateWidth(start.width + delta);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      resizeRef.current = null;
    };
    resizeRef.current = { move, end };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
    window.addEventListener('pointercancel', end, { once: true });
  };

  const openExpanded = () => {
    setPlaceholderHeight(frameRef.current?.getBoundingClientRect().height || 0);
    setExpanded(true);
  };

  const closeExpanded = () => {
    setExpanded(false);
    window.requestAnimationFrame(() => expandButtonRef.current?.focus());
  };

  return (
    <>
      <div
        ref={frameRef}
        className={`resizable-media ${className}`.trim()}
        style={inlineWidth == null ? undefined : { width: `${inlineWidth}px` }}
        data-resized={inlineWidth == null ? undefined : 'true'}
        {...props}
        data-media-align={alignable ? alignment : undefined}
      >
        {expanded ? (
          <div className="media-inline-placeholder" style={{ height: placeholderHeight }} />
        ) : (
          <>
            <div className="media-toolbar" data-copy-ignore>
              {alignable && (
                <AlignmentControls
                  alignment={alignment}
                  label={label}
                  onChange={onAlignmentChange}
                />
              )}
              <button
                ref={expandButtonRef}
                type="button"
                className="media-icon-button"
                onClick={openExpanded}
                aria-label={`放大查看${label}`}
                title="放大查看"
              >
                <ExpandIcon />
              </button>
              {onDownload && (
                <button
                  type="button"
                  className="media-icon-button"
                  onClick={onDownload}
                  aria-label="下载 SVG"
                  title="下载 SVG"
                >
                  <DownloadIcon />
                </button>
              )}
            </div>
            <div className="resizable-media-content">{children}</div>
            <button
              type="button"
              className="media-resize-handle"
              onPointerDown={startResize}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                  event.preventDefault();
                  updateWidth((inlineWidth || frameRef.current?.getBoundingClientRect().width || 0) + 24);
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  updateWidth((inlineWidth || frameRef.current?.getBoundingClientRect().width || 0) - 24);
                } else if (event.key === 'Home') {
                  event.preventDefault();
                  setInlineWidth(null);
                }
              }}
              aria-label={`调整${label}大小`}
              title="拖拽调整大小；方向键微调，Home 恢复"
            >
              <ResizeIcon />
            </button>
          </>
        )}
      </div>
      {expanded && (
        <MediaLightbox
          alignment={alignment}
          alignable={alignable}
          label={label}
          onAlignmentChange={onAlignmentChange}
          onClose={closeExpanded}
          onDownload={onDownload}
        >
          {children}
        </MediaLightbox>
      )}
    </>
  );
}
