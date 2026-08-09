/**
 * 飞牛开放 API 客户端。
 *
 * 两条硬约束（来自官方文档，务必不要改动）：
 *  1. 只能由应用服务端通过 Unix Socket 调用：
 *     /var/run/trim_open_gateway_apiscope.socket
 *  2. TRIM_API_TOKEN 由系统注入环境变量，可能在重装/重注册后变化。
 *     => 每次调用都从 process.env 现读，绝不持久化，绝不下发给前端。
 */
const http = require('node:http');

const SOCKET_PATH =
  process.env.TRIM_OPEN_API_SOCKET ||
  '/var/run/trim_open_gateway_apiscope.socket';

const APP_NAME = process.env.TRIM_APPNAME || 'flux-reader';
const OPEN_API_TIMEOUT_MS = 10_000;

let reqSeq = 0;

/** 开放 API 是否可用（本地开发机上没有这个 socket） */
function isAvailable() {
  return Boolean(process.env.TRIM_API_TOKEN);
}

/**
 * 调用一次开放 API。
 * @param {string} req  能力名，如 'trim.file.getSharedAccessibleFolders'
 * @param {object} data 业务参数
 * @returns {Promise<object>} 返回 data 字段；code !== 0 时抛错
 */
function callOpenApi(req, data = {}) {
  // 每次现读，不缓存
  const token = process.env.TRIM_API_TOKEN;
  if (!token) {
    const err = new Error(
      'TRIM_API_TOKEN 不存在：当前不在 fnOS 应用运行环境中，或应用需重新安装',
    );
    err.code = 'NO_TOKEN';
    err.status = 503;
    throw err;
  }

  const payload = JSON.stringify({
    reqId: String(++reqSeq),
    req,
    appName: APP_NAME,
    data,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let request;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      // 请求已有结果后取消 socket 超时计时，避免迟到的 timeout
      // 再次触发错误分支。settled 仍是最终的单次结算保护。
      try {
        request?.setTimeout?.(0);
      } catch {
        // 已销毁请求的计时器清理失败不应阻止 Promise 结算。
      }
      fn(value);
    };
    const succeed = (value) => settle(resolve, value);
    const fail = (err) => {
      const normalized = err instanceof Error ? err : new Error(String(err));
      // 开放 API 的超时、响应中断、传输错误、非 JSON 和业务非零码
      // 都是上游网关失败，对 HTTP 调用方统一映射为 502。
      if (!normalized.status) normalized.status = 502;
      settle(reject, normalized);
    };

    try {
      request = http.request(
        {
          socketPath: SOCKET_PATH,
          path: '/api/v1/trimapp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.once('aborted', () => {
            const err = new Error(`开放 API 响应在接收完成前中断 (HTTP ${res.statusCode})`);
            err.code = 'OPEN_API_RESPONSE_ABORTED';
            fail(err);
          });
          res.once('error', fail);
          res.once('close', () => {
            if (!res.complete) {
              const err = new Error(`开放 API 响应未完整关闭 (HTTP ${res.statusCode})`);
              err.code = 'OPEN_API_RESPONSE_ABORTED';
              fail(err);
            }
          });
          res.once('end', () => {
            if (settled) return;
            let parsed;
            try {
              parsed = JSON.parse(body);
            } catch {
              return fail(
                new Error(
                  `开放 API 返回非 JSON (HTTP ${res.statusCode}): ${body.slice(0, 200)}`,
                ),
              );
            }
            if (parsed.code !== 0) {
              // 常见错误码：403/200003 检查 api-scope 声明；404/200005 检查 req 拼写或系统版本
              const err = new Error(
                `开放 API ${req} 失败: code=${parsed.code} msg=${parsed.msg || ''}`,
              );
              err.apiCode = parsed.code;
              return fail(err);
            }
            succeed(parsed.data);
          });
        },
      );
    } catch (err) {
      fail(err);
      return;
    }
    request.setTimeout(OPEN_API_TIMEOUT_MS, () => {
      const err = new Error(`开放 API ${req} 超时（${OPEN_API_TIMEOUT_MS}ms）`);
      err.code = 'OPEN_API_TIMEOUT';
      // setTimeout 只发出通知，不会自动中断请求，必须显式 destroy。
      try {
        request.destroy(err);
      } finally {
        fail(err);
      }
    });
    request.once('error', fail);
    try {
      request.write(payload);
      request.end();
    } catch (err) {
      try {
        request.destroy();
      } finally {
        fail(err);
      }
    }
  });
}

/** 查询管理员在应用设置中授权给本应用的共享目录 */
function getSharedAccessibleFolders() {
  return callOpenApi('trim.file.getSharedAccessibleFolders');
}

/**
 * 检查当前使用用户对若干路径的权限（双层权限检查的第二层）。
 *
 * 重要语义：路径不存在、或应用无权读取路径状态时，
 * readable/writable/deletable 三者都返回 false。
 * 因此 false 不能一律解释为「权限被拒绝」。
 *
 * @returns {Promise<Record<string, {readable:boolean,writable:boolean,deletable:boolean}>>}
 */
async function checkUserACL(uid, paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  const data = await callOpenApi('trim.file.checkUserACL', {
    uid: Number(uid),
    path: list,
  });
  // 兼容返回为数组或以 path 为 key 的对象两种形态
  if (Array.isArray(data)) {
    const map = {};
    data.forEach((item, i) => {
      // 始终以请求路径建 key：网关可能把 /proc/<pid>/fd/<n>
      // canonicalize 成真实路径后再放到 item.path。这里仍然使用的是
      // 「稳定 fd 请求」的返回结果，不是回退另一次 actualPath 授权。
      if (list[i]) map[list[i]] = item;
      if (item?.path) map[item.path] = item;
    });
    return map;
  }
  return data || {};
}

/** 把 /vol1/1000/photo 转成 存储空间1/admin 的文件/photo（界面展示用，language 必填） */
async function convertPath(paths, language = 'zh-CN') {
  const list = Array.isArray(paths) ? paths : [paths];
  try {
    return await callOpenApi('trim.file.convertPath', { path: list, language });
  } catch {
    return null; // 展示层降级，不影响主流程
  }
}

module.exports = {
  isAvailable,
  callOpenApi,
  getSharedAccessibleFolders,
  checkUserACL,
  convertPath,
  APP_NAME,
};
