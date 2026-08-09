/**
 * Mermaid 图表组件。
 *
 * 实现要点：
 *  - 动态 import，不进主包
 *  - 深浅两套完整 themeVariables，跟随 NAS 系统主题
 *  - 渲染出的 SVG 支持下载
 */
import { useEffect, useId, useRef, useState } from 'react';

/* zinc 色板，与应用整体配色保持一致 */
const DARK_VARS = {
  primaryColor: '#27272a',
  primaryTextColor: '#fafafa',
  primaryBorderColor: '#3f3f46',
  secondaryColor: '#121214',
  secondaryTextColor: '#a1a1aa',
  secondaryBorderColor: '#3f3f46',
  tertiaryColor: '#09090b',
  tertiaryTextColor: '#a1a1aa',
  tertiaryBorderColor: '#27272a',
  lineColor: '#3f3f46',
  textColor: '#fafafa',
  mainBkg: '#27272a',
  nodeBkg: '#27272a',
  nodeBorder: '#3f3f46',
  clusterBkg: '#09090b',
  clusterBorder: '#27272a',
  titleColor: '#fafafa',
  edgeLabelBackground: '#121214',
  nodeTextColor: '#fafafa',
};

const LIGHT_VARS = {
  primaryColor: '#f4f4f5',
  primaryTextColor: '#09090b',
  primaryBorderColor: '#d4d4d8',
  secondaryColor: '#e4e4e7',
  secondaryTextColor: '#3f3f46',
  secondaryBorderColor: '#d4d4d8',
  tertiaryColor: '#fafafa',
  tertiaryTextColor: '#52525b',
  tertiaryBorderColor: '#e4e4e7',
  lineColor: '#a1a1aa',
  textColor: '#09090b',
  mainBkg: '#f4f4f5',
  nodeBkg: '#f4f4f5',
  nodeBorder: '#d4d4d8',
  clusterBkg: '#fafafa',
  clusterBorder: '#e4e4e7',
  titleColor: '#09090b',
  edgeLabelBackground: '#ffffff',
  nodeTextColor: '#09090b',
};

export default function Mermaid({ code, theme }) {
  const rawId = useId().replace(/:/g, '-');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const aliveRef = useRef(true);
  // 给 mermaid 的离屏渲染容器：不传这个参数它会把临时 div append 到
  // document.body（见下方 initialize 注释）
  const stageRef = useRef(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!code?.trim()) return;
    let cancelled = false;

    (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        const isDark = theme === 'dark';
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict', // 不允许图表里注入脚本
          theme: isDark ? 'dark' : 'neutral',
          themeVariables: isDark ? DARK_VARS : LIGHT_VARS,
          fontFamily: 'inherit',
          // 语法出错时不要让 mermaid 自己往 DOM 里插那张「Syntax error」炸弹图。
          //
          // 不加这个开关会留下一个脱离 React 树的孤儿节点：mermaid 内部先把
          // 错误图渲进临时容器，再 throw，而清理临时容器的 removeTempElements()
          // 写在 throw 之后，永远执行不到。该容器又默认挂在 document.body 上，
          // 于是错误图会浮在整个应用之上、压住侧边栏，且我们无从清理。
          // 开启后 mermaid 会先清理再抛错，异常仍由下面的 catch 接管，
          // 走我们自己的降级 UI。
          suppressErrorRendering: true,
        });
        // 第三个参数指定离屏容器，避免临时节点挂到 document.body 影响布局。
        // mermaid 会自行校验语法，失败抛错
        const { svg: out } = await mermaid.render(
          `mermaid-${rawId}`,
          code,
          stageRef.current || undefined,
        );
        if (!cancelled && aliveRef.current) {
          setSvg(out);
          setError('');
        }
      } catch (err) {
        if (!cancelled && aliveRef.current) {
          setSvg('');
          setError(err?.message || '图表渲染失败');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, theme, rawId]);

  const download = () => {
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'diagram.svg';
    a.click();
    URL.revokeObjectURL(url);
  };

  // 离屏渲染容器。必须在所有分支中都存在且始终挂载：
  // 它要在 effect 首次执行前就位，且不能随渲染状态被卸载（否则重渲染时
  // stageRef 为 null，mermaid 又会退回 document.body）。
  const stage = <div ref={stageRef} className="mermaid-stage" aria-hidden="true" />;

  if (error) {
    return (
      <div className="mermaid-error">
        {stage}
        <div className="mermaid-error-title">Mermaid 语法错误</div>
        <pre>{error}</pre>
        <pre className="mermaid-error-source">{code}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="mermaid-loading">
        {stage}
        图表渲染中…
      </div>
    );
  }

  return (
    <div className="mermaid-block">
      {stage}
      <div className="mermaid-toolbar">
        <button type="button" onClick={download} title="下载 SVG">
          下载 SVG
        </button>
      </div>
      {/* mermaid 以 securityLevel:strict 生成，且内容源自本地文件 */}
      <div className="mermaid-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}
