//! 微信安装的一次性原生确认；不把桌面 IPC 冒充 Web 登录会话。
use base64::Engine;
use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256, Sha512};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

const PACKAGE_NAME: &str = "@tencent-weixin/openclaw-weixin";
const VERSION: &str = "2.4.9";
const PLUGIN_ID: &str = "openclaw-weixin";
const ARTIFACT_URL: &str =
    "https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.9.tgz";
const ARTIFACT_SHA256: &str = "467e8047f7114e45944961fcd3eda9421843c9c65db61ea24176e252ab800ee4";
const INTEGRITY: &str = "sha512-SfaYehR1Cwq2VV5HxJBp9sVilMms420VfZlMbF4YjRbWomr5+GxfXp9HkeU6y5TbnOc4Ysq0qPw1yBvJwbenBA==";
const MANIFEST_SHA256: &str = "48e1be8ff065494ea9fc58ca8d1333ec60e6d91c51ada182c700ee190638d5cd";
const REVIEW_TOKEN: &str = "4a6ad49339885fb96a4109d552d1cb3c87838ec519726805888d8cadd73d696d";
const TTL_MS: u64 = 300_000;
const COMPRESSED_MAX: usize = 1_048_576;
const UNPACKED_MAX: usize = 4_194_304;
const OUTPUT_MAX: usize = 1_048_576;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    version: &'static str,
    url: &'static str,
    integrity: &'static str,
    sha256: &'static str,
    manifest_sha256: &'static str,
    file_count: usize,
    unpacked_size: usize,
    compressed_size: usize,
    sdk_subpath: &'static str,
    source_commit: &'static str,
}
const ARTIFACT_249: Artifact = Artifact {
    version: VERSION,
    url: ARTIFACT_URL,
    integrity: INTEGRITY,
    sha256: ARTIFACT_SHA256,
    manifest_sha256: MANIFEST_SHA256,
    file_count: 125,
    unpacked_size: 696_653,
    compressed_size: 172_146,
    sdk_subpath: "openclaw/plugin-sdk/infra-runtime",
    source_commit: "43675b66551d12d6853155a7869a50fb12a18a1e",
};
const ARTIFACT_2410: Artifact = Artifact { version:"2.4.10", url:"https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.10.tgz", integrity:"sha512-qCN7rFtBK5BO/i5YGEJLdpC/8WQrm0dtPlQ0xNxku4RSyzGaRsiBoLVheU5hgpoOIBvfc5pUwKTktMbROLcIVg==", sha256:"69dd18af16a992edbe3700d244f9591ab52f5f58abfe976a9f1250bd8eacdbbb", manifest_sha256:"43957bcf2852862a337f7606a4c352c443e67eda16424a4cd158425768e6b1b8", file_count:131, unpacked_size:696_593, compressed_size:172_518, sdk_subpath:"openclaw/plugin-sdk/temp-path", source_commit:"c6643f6f0ac03574eb126f2d69569ea4267cc3c6" };
static STORE: LazyLock<Mutex<ConsentStore>> = LazyLock::new(|| Mutex::new(ConsentStore::default()));
static CLOCK: LazyLock<Instant> = LazyLock::new(Instant::now);

fn failure(code: &str, reason: &str) -> String {
    format!("{code}: {reason}")
}
fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn now_ms() -> u64 {
    CLOCK.elapsed().as_millis() as u64
}
fn secret_equal(a: &str, b: &str) -> bool {
    let a = Sha256::digest(a.as_bytes());
    let b = Sha256::digest(b.as_bytes());
    a.iter()
        .zip(b)
        .fold(0u8, |difference, (x, y)| difference | (x ^ y))
        == 0
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Binding {
    caller: String,
    operation: String,
    host_version: String,
    host_cli: String,
    config_sha256: String,
    installed_version: Option<String>,
    installed_path: String,
    installed_sha256: Option<String>,
    artifact: Artifact,
    host_sdk: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ticket {
    operation_id: String,
    confirmation_token: String,
    expires_at: String,
}
struct Approval {
    operation_id: String,
    confirmation_token: String,
    accepted: bool,
    artifact_sha256: String,
    review_token: String,
}
#[derive(Debug)]
struct Pending {
    binding: Binding,
    archive: Vec<u8>,
    token_digest: String,
    expires_ms: u64,
}
#[derive(Default)]
struct ConsentStore {
    pending: HashMap<String, Pending>,
}
impl ConsentStore {
    fn issue(&mut self, binding: Binding, archive: Vec<u8>, now: u64) -> Result<Ticket, String> {
        self.pending.retain(|_, p| p.expires_ms > now);
        if self.pending.len() >= 8
            || self
                .pending
                .values()
                .filter(|p| p.binding.caller == binding.caller)
                .count()
                >= 2
        {
            return Err(failure("WEIXIN_BUSY", "待确认操作已达上限，请取消旧操作"));
        }
        if archive.len() > COMPRESSED_MAX {
            return Err(failure("WEIXIN_UNSAFE_ARTIFACT", "压缩包超限"));
        }
        let mut id = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut id);
        id[6] = (id[6] & 15) | 64;
        id[8] = (id[8] & 63) | 128;
        let h = id.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let operation_id = format!(
            "{}-{}-{}-{}-{}",
            &h[..8],
            &h[8..12],
            &h[12..16],
            &h[16..20],
            &h[20..]
        );
        let mut secret = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut secret);
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret);
        let ticket = Ticket {
            operation_id: operation_id.clone(),
            confirmation_token: token.clone(),
            expires_at: (chrono::Utc::now() + chrono::Duration::milliseconds(TTL_MS as i64))
                .to_rfc3339(),
        };
        self.pending.insert(
            operation_id,
            Pending {
                binding,
                archive,
                token_digest: sha256(token.as_bytes()),
                expires_ms: now.saturating_add(TTL_MS),
            },
        );
        Ok(ticket)
    }
    fn lookup(&self, caller: &str, id: &str, token: &str, now: u64) -> Result<&Pending, String> {
        if id.len() != 36 || token.len() != 43 {
            return Err(failure("WEIXIN_USED", "操作凭证无效或已消费"));
        }
        let p = self
            .pending
            .get(id)
            .ok_or_else(|| failure("WEIXIN_USED", "操作不存在或已消费"))?;
        if p.binding.caller != caller || !secret_equal(&p.token_digest, &sha256(token.as_bytes())) {
            return Err(failure("WEIXIN_SESSION", "操作不属于当前原生窗口"));
        }
        if now >= p.expires_ms {
            return Err(failure("WEIXIN_EXPIRED", "确认已过期，请重新准备"));
        }
        Ok(p)
    }
    fn claim(&mut self, binding: &Binding, a: &Approval, now: u64) -> Result<Pending, String> {
        if !a.accepted {
            return Err(failure("WEIXIN_CONSENT_REQUIRED", "需要明确确认本次安装"));
        }
        if a.artifact_sha256 != binding.artifact.sha256 || a.review_token != REVIEW_TOKEN {
            return Err(failure(
                "WEIXIN_ARTIFACT_CHANGED",
                "确认内容发生变化，请重新准备",
            ));
        }
        let p = self.lookup(&binding.caller, &a.operation_id, &a.confirmation_token, now)?;
        if p.binding != *binding {
            return Err(failure(
                "WEIXIN_HOST_CHANGED",
                "内核、插件或配置已变化，请重新准备",
            ));
        }
        // 在任何安装 await 之前消费；失败也不恢复或自动重试。
        self.pending
            .remove(&a.operation_id)
            .ok_or_else(|| failure("WEIXIN_USED", "凭证已消费"))
    }
    fn cancel(&mut self, caller: &str, id: &str, token: &str, now: u64) -> Result<(), String> {
        self.lookup(caller, id, token, now)?;
        self.pending.remove(id);
        Ok(())
    }
}

fn caller_identity(label: &str, value: &str, debug: bool) -> Result<String, String> {
    let url = tauri::Url::parse(value).map_err(|_| failure("WEIXIN_ORIGIN", "原生窗口来源无效"))?;
    let local = url.username().is_empty()
        && url.password().is_none()
        && ((url.scheme() == "tauri"
            && url.host_str() == Some("localhost")
            && url.port().is_none())
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")
                && url.port().is_none())
            || (debug
                && url.scheme() == "http"
                && url.host_str() == Some("localhost")
                && url.port() == Some(1420)));
    if label != "main" || !local {
        return Err(failure("WEIXIN_ORIGIN", "仅可信主窗口可确认安装"));
    }
    Ok(format!(
        "native:{label}:{}://{}:{}",
        url.scheme(),
        url.host_str().unwrap_or_default(),
        url.port_or_known_default().unwrap_or(0)
    ))
}
fn native_caller(window: &tauri::WebviewWindow) -> Result<String, String> {
    // Tauri 2.11.1 的自定义命令远程来源分支使用 InvokeRequest.url；
    // WebView2 对不可信 iframe 的真实传值/拒绝行为仍需 VM 正反向验收，不能用单测冒充。
    // 再检查真实 webview 身份与当前顶页；绝不接受调用者提交的 session/origin 字符串。
    caller_identity(
        window.label(),
        window.url().map_err(|e| e.to_string())?.as_str(),
        cfg!(debug_assertions),
    )
}
pub(super) fn requires_consent(package: &str, id: Option<&str>) -> bool {
    let p = package.trim().to_ascii_lowercase();
    // 通用入口只接受可识别的普通 npm 名称/版本；URL、文件和 npm alias 可遮蔽真实包身份。
    // 这些来源不得借旧安装入口把同意变成隐式全局开关，其他普通 npm 插件保持原流程。
    let npm = regex::Regex::new(
        r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9][a-z0-9._-]*)?$",
    )
    .expect("固定 npm 来源模式");
    let archive = [".tgz", ".tar.gz", ".zip", ".js", ".ts"]
        .iter()
        .any(|suffix| p.ends_with(suffix));
    id.is_some_and(|id| matches!(id.trim(), "weixin" | "wechat" | "openclaw-weixin"))
        || matches!(p.as_str(), "weixin" | "wechat")
        || p.contains(PLUGIN_ID)
        || archive
        || !npm.is_match(&p)
}
pub(super) fn consent_required() -> String {
    failure(
        "WEIXIN_CONSENT_REQUIRED",
        "请先查看精确版本与能力说明，再明确确认微信插件安装",
    )
}
fn capability_mode(host: &str) -> Result<&'static str, String> {
    match reviewed_host_base(host)? {
        "2026.9.8" | "2026.10.4" => Ok("native-cli"),
        "2026.5.12" => Ok("legacy-reviewed"),
        _ => Err(failure(
            "WEIXIN_LEGACY_UNSUPPORTED",
            "当前内核的确认参数尚未核实，请保留现有插件",
        )),
    }
}
fn reviewed_host_base(host: &str) -> Result<&str, String> {
    let re = regex::Regex::new(r"^v?(2026\.(?:5\.12|9\.8|10\.4))(?:-(\d+))?(?:-zh\.(\d+))?$")
        .expect("固定已核宿主语法");
    let captures = re
        .captures(host.trim())
        .ok_or_else(|| failure("WEIXIN_LEGACY_UNSUPPORTED", "宿主不在已核稳定矩阵内"))?;
    for i in [2, 3] {
        if captures
            .get(i)
            .is_some_and(|m| m.as_str().parse::<u32>().is_err())
        {
            return Err(failure("WEIXIN_LEGACY_UNSUPPORTED", "版本数字超界"));
        }
    }
    Ok(captures.get(1).ok_or("宿主版本缺失")?.as_str())
}
fn artifact_for_host(host: &str) -> Result<Artifact, String> {
    Ok(if reviewed_host_base(host)? == "2026.10.4" {
        ARTIFACT_2410
    } else {
        ARTIFACT_249
    })
}
struct PriorState {
    repairing: bool,
    public: Value,
}
fn prior_state(host: &str, installed: Option<&str>) -> Result<PriorState, String> {
    let artifact = artifact_for_host(host)?;
    let Some(version) = installed else {
        return Ok(PriorState {
            repairing: false,
            public: json!({"compatible":null,"compatError":""}),
        });
    };
    if artifact.version == "2.4.10" && version == "2.4.9" {
        return Ok(PriorState {
            repairing: true,
            public: json!({"compatible":false,"compatError":"既有2.4.9依赖当前宿主缺失的SDK导出；需显式确认修复升级2.4.10，不将旧包视为健康"}),
        });
    }
    if version == artifact.version {
        return Ok(PriorState {
            repairing: false,
            public: json!({"compatible":true,"compatError":""}),
        });
    }
    // 2410 在旧host及未知版本均未核实；不降级，也不从peer下限推断兼容。
    if version == "2.4.10" || artifact.version == "2.4.10" {
        return Err(failure(
            "WEIXIN_HOST_CHANGED",
            "既有插件不在本宿主已核修复范围，保留原状",
        ));
    }
    let public = super::weixin_compat::compatibility(host, version);
    if public["compatible"].as_bool() != Some(true) {
        return Err(failure(
            "WEIXIN_HOST_CHANGED",
            "既有插件不在已核兼容矩阵，保留原状",
        ));
    }
    Ok(PriorState {
        repairing: false,
        public,
    })
}
fn validate_cli_help(host: &str, help: &str) -> Result<&'static str, String> {
    let mode = capability_mode(host)?;
    let native = regex::Regex::new(r"--accept-capabilities\b")
        .expect("固定 CLI 参数")
        .is_match(help);
    if (mode == "native-cli") != native || !help.contains("--force") {
        return Err(failure(
            "WEIXIN_LEGACY_UNSUPPORTED",
            "实际 CLI help 与已核版本的参数契约不符",
        ));
    }
    Ok(mode)
}
fn install_arguments(archive: &Path, mode: &str, operation: &str) -> Result<Vec<String>, String> {
    if !matches!(operation, "install" | "upgrade")
        || !matches!(mode, "native-cli" | "legacy-reviewed")
    {
        return Err(consent_required());
    }
    let mut args = vec![
        "plugins".into(),
        "install".into(),
        archive.to_string_lossy().into_owned(),
    ];
    // 已明确确认精确本地包/来源后，新 CLI 首装仍要求 --force；旧 CLI 仅升级使用。
    // 此参数不替代 --accept-capabilities，也不屏蔽上游扫描或其他策略错误。
    if operation == "upgrade" || mode == "native-cli" {
        args.push("--force".into());
    }
    if mode == "native-cli" {
        args.push("--accept-capabilities".into());
    }
    Ok(args)
}
fn declared_surface() -> Value {
    json!({"channels":[PLUGIN_ID],"providers":[],"tools":[],"contracts":[],"hooks":[],"mcpServers":[],"cliCommands":[],"cliBackends":[],"skills":[],"dangerousConfigFlags":[]})
}
#[cfg(test)]
fn verify_compressed(bytes: &[u8]) -> Result<(), String> {
    verify_compressed_for(bytes, &ARTIFACT_249)
}
fn verify_compressed_for(bytes: &[u8], artifact: &Artifact) -> Result<(), String> {
    let sri = format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes))
    );
    if bytes.len() > COMPRESSED_MAX
        || bytes.len() != artifact.compressed_size
        || sha256(bytes) != artifact.sha256
        || sri != artifact.integrity
    {
        return Err(failure(
            "WEIXIN_ARTIFACT_CHANGED",
            "精确压缩包 SHA256/SRI 校验失败",
        ));
    }
    Ok(())
}
#[cfg(test)]
fn validate_manifest(bytes: &[u8]) -> Result<Value, String> {
    validate_manifest_for(bytes, &ARTIFACT_249)
}
fn validate_manifest_for(bytes: &[u8], artifact: &Artifact) -> Result<Value, String> {
    if sha256(bytes) != artifact.manifest_sha256 {
        return Err(failure(
            "WEIXIN_ARTIFACT_CHANGED",
            "manifest 字节或能力声明已变化",
        ));
    }
    let m: Value = serde_json::from_slice(bytes)
        .map_err(|_| failure("WEIXIN_UNSAFE_ARTIFACT", "manifest JSON 无效"))?;
    if m["id"] != PLUGIN_ID
        || m["version"] != artifact.version
        || m["channels"] != json!([PLUGIN_ID])
        || m.get("capabilities").is_some()
    {
        return Err(failure("WEIXIN_ARTIFACT_CHANGED", "声明与固定审核不一致"));
    }
    Ok(declared_surface())
}
#[derive(Debug)]
struct FileCheck {
    relative_path: String,
    sha256: String,
    size: usize,
}
#[derive(Debug, Default)]
struct ArchiveReview {
    files: usize,
    unpacked_size: usize,
    manifest: Vec<u8>,
    package: Vec<u8>,
    findings: Vec<Value>,
    file_checks: Vec<FileCheck>,
}
struct ValidatedReview {
    public: Value,
    file_checks: Vec<FileCheck>,
}
fn octal(bytes: &[u8]) -> Result<usize, String> {
    let s = std::str::from_utf8(bytes)
        .map_err(|_| "tar 数字无效")?
        .trim_matches(['\0', ' ']);
    if s.is_empty() {
        return Ok(0);
    }
    usize::from_str_radix(s, 8).map_err(|_| failure("WEIXIN_UNSAFE_ARTIFACT", "tar 数字超界"))
}
fn tar_text(bytes: &[u8]) -> Result<&str, String> {
    std::str::from_utf8(bytes.split(|b| *b == 0).next().unwrap_or_default())
        .map_err(|_| failure("WEIXIN_UNSAFE_ARTIFACT", "tar 路径编码无效"))
}
fn parse_tar(bytes: &[u8]) -> Result<ArchiveReview, String> {
    if bytes.len() > UNPACKED_MAX {
        return Err(failure("WEIXIN_UNSAFE_ARTIFACT", "解压预算超限"));
    }
    let mut review = ArchiveReview::default();
    let mut seen = HashSet::new();
    let mut offset = 0usize;
    let mut entries = 0;
    let mut risks = HashSet::new();
    while offset + 512 <= bytes.len() {
        let header = &bytes[offset..offset + 512];
        if header.iter().all(|b| *b == 0) {
            if bytes[offset..].iter().any(|b| *b != 0) {
                return Err(failure("WEIXIN_UNSAFE_ARTIFACT", "tar 尾部含额外内容"));
            }
            let mut codes: Vec<_> = risks.into_iter().collect();
            codes.sort_unstable();
            review.findings = codes
                .into_iter()
                .map(|code| json!({"code":code,"severity":"warning"}))
                .collect();
            return Ok(review);
        }
        entries += 1;
        if entries > 256 {
            return Err(failure("WEIXIN_UNSAFE_ARTIFACT", "条目数量超限"));
        }
        let checksum: usize = header
            .iter()
            .enumerate()
            .map(|(i, b)| {
                if (148..156).contains(&i) {
                    32
                } else {
                    usize::from(*b)
                }
            })
            .sum();
        if octal(&header[148..156])? != checksum {
            return Err(failure("WEIXIN_UNSAFE_ARTIFACT", "tar header 校验失败"));
        }
        let name = tar_text(&header[..100])?;
        let prefix = tar_text(&header[345..500])?;
        let name = if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}/{name}")
        };
        let parts: Vec<_> = name.trim_end_matches('/').split('/').collect();
        if parts.len() > 12
            || parts.first() != Some(&"package")
            || parts.iter().any(|p| {
                p.is_empty()
                    || matches!(*p, "." | "..")
                    || p.contains(['\\', ':'])
                    || p.ends_with([' ', '.'])
            })
            || !seen.insert(name.to_ascii_lowercase())
        {
            return Err(failure(
                "WEIXIN_UNSAFE_ARTIFACT",
                "归档路径、重复条目或深度不安全",
            ));
        }
        let size = octal(&header[124..136])?;
        if size > COMPRESSED_MAX
            || !matches!(header[156], 0 | b'0' | b'5')
            || (header[156] == b'5' && size != 0)
        {
            return Err(failure(
                "WEIXIN_UNSAFE_ARTIFACT",
                "归档含链接、特殊条目或超大文件",
            ));
        }
        let start = offset + 512;
        let end = start
            .checked_add(size)
            .filter(|end| *end <= bytes.len())
            .ok_or("归档内容被截断")?;
        let data = &bytes[start..end];
        if header[156] != b'5' {
            if parts.len() < 2 {
                return Err(failure("WEIXIN_UNSAFE_ARTIFACT", "归档文件不在包根目录内"));
            }
            review.files += 1;
            review.unpacked_size += size;
            review.file_checks.push(FileCheck {
                relative_path: parts[1..].join("/"),
                sha256: sha256(data),
                size,
            });
            if name == "package/openclaw.plugin.json" {
                review.manifest = data.to_vec();
            }
            if name == "package/package.json" {
                review.package = data.to_vec();
            }
            if name.ends_with(".js") || name.ends_with(".ts") {
                let text = String::from_utf8_lossy(data);
                for (needle, code) in [
                    ("fetch(", "network-access"),
                    ("node:fs", "local-file-access"),
                    ("node:child_process", "process-execution"),
                    ("process.env", "environment-access"),
                ] {
                    if text.contains(needle) {
                        risks.insert(code);
                    }
                }
            }
        }
        offset = start + size.div_ceil(512) * 512;
    }
    Err(failure("WEIXIN_UNSAFE_ARTIFACT", "归档缺少完整结束标记"))
}
fn review_tar_for(bytes: &[u8], artifact: &Artifact) -> Result<ValidatedReview, String> {
    let mut r = parse_tar(bytes)?;
    if r.files != artifact.file_count || r.unpacked_size != artifact.unpacked_size {
        return Err(failure(
            "WEIXIN_ARTIFACT_CHANGED",
            "文件数或解包大小与审核包不符",
        ));
    }
    let declared = validate_manifest_for(&r.manifest, artifact)?;
    let p: Value = serde_json::from_slice(&r.package).map_err(|_| "package.json 无效")?;
    if p["name"] != PACKAGE_NAME
        || p["version"] != artifact.version
        || p["peerDependencies"]["openclaw"] != ">=2026.5.12"
    {
        return Err(failure("WEIXIN_ARTIFACT_CHANGED", "包身份与 SDK 要求不符"));
    }
    // 固定包的静态代码审核发现仅作提示，不取代 CLI 的危险代码扫描或安全策略。
    r.findings.push(json!({"code":"network-and-local-data","severity":"warning","message":"此第三方渠道代码会访问外部服务和本地数据；静态声明不是权限沙箱"}));
    Ok(ValidatedReview {
        public: json!({"manifestSha256":artifact.manifest_sha256,"reviewToken":REVIEW_TOKEN,"declared":declared,"previousDeclared":null,"addedDeclared":declared,"warnings":["第三方插件在 Gateway 进程中执行，不是操作系统沙箱。","准备阶段不执行插件；上游安装扫描、策略与原始错误仍会保留。","旧版本声明面未核实的部分按完整新增能力展示。"],"scan":{"status":"reviewed","scope":"bounded-static-exact-artifact; upstream installer scan remains mandatory","findings":r.findings}}),
        file_checks: r.file_checks,
    })
}

fn ensure_no_links(path: &Path) -> Result<(), String> {
    for p in path.ancestors() {
        if p.as_os_str().is_empty() {
            continue;
        }
        match fs::symlink_metadata(p) {
            Ok(m) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if m.file_attributes() & 0x400 != 0 {
                        return Err(failure("WEIXIN_UNSAFE_ARTIFACT", "路径包含重解析点"));
                    }
                }
                if m.file_type().is_symlink() {
                    return Err(failure("WEIXIN_UNSAFE_ARTIFACT", "路径包含链接"));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(format!("WEIXIN_UNSAFE_ARTIFACT: 路径检查失败: {e}")),
        }
    }
    Ok(())
}
fn read_file(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    ensure_no_links(path)?;
    let file = fs::File::open(path).map_err(|e| format!("文件回读失败: {e}"))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("回读目标不是普通文件".into());
    }
    let mut data = Vec::new();
    file.take(max as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() > max {
        return Err("文件回读超过预算".into());
    }
    Ok(data)
}
#[cfg(test)]
fn protected_config(config: &Value) -> Value {
    protected_config_for(config, "2026.9.8")
}
fn remove_empty(parent: &mut Value, key: &str) {
    if parent
        .get(key)
        .is_some_and(|v| v.as_object().is_some_and(|m| m.is_empty()))
    {
        if let Some(m) = parent.as_object_mut() {
            m.remove(key);
        }
    }
}
fn protected_config_for(config: &Value, host: &str) -> Value {
    let mut copy = config.clone();
    if let Some(plugins) = copy.get_mut("plugins") {
        if let Some(entries) = plugins.get_mut("entries") {
            if let Some(entry) = entries.get_mut(PLUGIN_ID).and_then(Value::as_object_mut) {
                entry.remove("enabled");
            }
            remove_empty(entries, PLUGIN_ID);
        }
        if let Some(installs) = plugins.get_mut("installs").and_then(Value::as_object_mut) {
            installs.remove(PLUGIN_ID);
        }
        remove_empty(plugins, "entries");
        remove_empty(plugins, "installs");
    }
    remove_empty(&mut copy, "plugins");
    if let Some(meta) = copy.get_mut("meta") {
        if meta["lastTouchedVersion"] == host {
            if let Some(m) = meta.as_object_mut() {
                m.remove("lastTouchedVersion");
                if m.get("lastTouchedAt")
                    .and_then(Value::as_str)
                    .is_some_and(|s| {
                        regex::Regex::new(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
                            .expect("固定时间格式")
                            .is_match(s)
                            && chrono::DateTime::parse_from_rfc3339(s).is_ok()
                    })
                {
                    m.remove("lastTouchedAt");
                }
            }
        }
        if let Some(m) = meta.get_mut("migrations").and_then(Value::as_object_mut) {
            for key in ["modelPolicyAllowlist", "utilityModelSeparation"] {
                if m.get(key) == Some(&json!(true)) {
                    m.remove(key);
                }
            }
        }
        remove_empty(meta, "migrations");
    }
    remove_empty(&mut copy, "meta");
    copy
}
fn inspect_sdk_root(root: &Path, host: &str, artifact: &Artifact) -> Result<String, String> {
    let bytes = read_file(&root.join("package.json"), COMPRESSED_MAX)?;
    let p: Value = serde_json::from_slice(&bytes)
        .map_err(|_| failure("WEIXIN_SDK_UNSUPPORTED", "SDK包manifest无效"))?;
    if !matches!(
        p["name"].as_str(),
        Some("openclaw" | "@qingchencloud/openclaw-zh")
    ) || p["version"] != host
    {
        return Err(failure(
            "WEIXIN_SDK_UNSUPPORTED",
            "SDK包不是实际已选宿主版本",
        ));
    }
    let key = format!(
        "./{}",
        artifact
            .sdk_subpath
            .strip_prefix("openclaw/")
            .ok_or("SDK子路径无效")?
    );
    let export = &p["exports"][&key];
    let target = export
        .as_str()
        .or_else(|| export["default"].as_str())
        .ok_or_else(|| {
            failure(
                "WEIXIN_SDK_UNSUPPORTED",
                "宿主缺少本次artifact需要的SDK导出",
            )
        })?;
    if !target.starts_with("./")
        || target.contains('\\')
        || target[2..]
            .split('/')
            .any(|v| v.is_empty() || matches!(v, "." | "..") || v.contains(':'))
    {
        return Err(failure("WEIXIN_SDK_UNSUPPORTED", "SDK导出路径不安全"));
    }
    let file = root.join(&target[2..]);
    ensure_no_links(&file)?;
    let canonical = fs::canonicalize(&file)
        .map_err(|_| failure("WEIXIN_SDK_UNSUPPORTED", "SDK导出文件缺失"))?;
    if !crate::utils::path_is_inside_or_same(
        &canonical,
        &fs::canonicalize(root).map_err(|e| e.to_string())?,
    ) {
        return Err(failure("WEIXIN_SDK_UNSUPPORTED", "SDK路径逃逸"));
    }
    let mut identity = bytes;
    identity.extend(read_file(&file, COMPRESSED_MAX)?);
    Ok(format!(
        "{}:{}:{}",
        root.to_string_lossy(),
        artifact.sdk_subpath,
        sha256(&identity)
    ))
}
fn sdk_identity(cli: &Path, host: &str, artifact: &Artifact) -> Result<String, String> {
    // 只查已选CLI同树的固定npm布局；找到宿主后不借用别处SDK以掩盖缺导出。
    for parent in cli.ancestors().skip(1).take(5) {
        for root in [
            parent.to_path_buf(),
            parent.join("node_modules/openclaw"),
            parent.join("node_modules/@qingchencloud/openclaw-zh"),
        ] {
            let manifest = root.join("package.json");
            if !manifest.is_file() {
                continue;
            }
            let bytes = read_file(&manifest, COMPRESSED_MAX)?;
            let p: Value = serde_json::from_slice(&bytes)
                .map_err(|_| failure("WEIXIN_SDK_UNSUPPORTED", "宿主manifest无效"))?;
            if matches!(
                p["name"].as_str(),
                Some("openclaw" | "@qingchencloud/openclaw-zh")
            ) {
                return inspect_sdk_root(&root, host, artifact);
            }
        }
    }
    Err(failure("WEIXIN_SDK_UNSUPPORTED", "未定位实际CLI的SDK包"))
}
fn managed_path(root: &Path, value: &Path) -> Result<PathBuf, String> {
    ensure_no_links(value)?;
    if !value.is_absolute() {
        return Err(failure("WEIXIN_HOST_CHANGED", "插件路径必须为实际绝对路径"));
    }
    let path = crate::utils::canonicalize_path_for_safety(value, "微信插件路径")?;
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        || crate::utils::path_compare_key(&path) == crate::utils::path_compare_key(root)
        || !crate::utils::path_is_inside_or_same(&path, root)
    {
        return Err(failure(
            "WEIXIN_HOST_CHANGED",
            "插件不在受管配置目录内，保留原状",
        ));
    }
    Ok(path)
}
fn cli_identity(path: &Path) -> Result<String, String> {
    Ok(format!(
        "{}:{}",
        path.to_string_lossy(),
        sha256(&read_file(path, 32 * 1024 * 1024)?)
    ))
}
fn command_pins_cli(command: &std::process::Command, expected: &Path) -> bool {
    let Ok(expected) = fs::canonicalize(expected) else {
        return false;
    };
    let matches = |p: &std::ffi::OsStr| {
        fs::canonicalize(Path::new(p)).is_ok_and(|p| {
            crate::utils::path_compare_key(&p) == crate::utils::path_compare_key(&expected)
        })
    };
    if matches(command.get_program()) {
        return true;
    }
    #[cfg(windows)]
    if Path::new(command.get_program())
        .file_name()
        .is_some_and(|n| {
            n.to_string_lossy().eq_ignore_ascii_case("cmd")
                || n.to_string_lossy().eq_ignore_ascii_case("cmd.exe")
        })
    {
        return command.get_args().any(matches);
    }
    false
}
struct Snapshot {
    binding: Binding,
    root: PathBuf,
    extension: PathBuf,
    cli: PathBuf,
    protected_config: Value,
    prior: PriorState,
}
fn host_command(state: &Snapshot) -> Result<tokio::process::Command, String> {
    let command = crate::utils::openclaw_command_async();
    if !command_pins_cli(command.as_std(), &state.cli)
        || cli_identity(&state.cli)? != state.binding.host_cli
    {
        return Err(failure("WEIXIN_HOST_CHANGED", "实际 CLI 来源发生变化"));
    }
    Ok(command)
}
async fn snapshot(caller: String, operation: &str) -> Result<Snapshot, String> {
    if !matches!(operation, "install" | "upgrade") {
        return Err(consent_required());
    }
    let home = super::openclaw_dir();
    ensure_no_links(&home)?;
    let root = fs::canonicalize(&home).map_err(|e| e.to_string())?;
    let host = super::config::installed_openclaw_version_from_files().ok_or("未检测到内核版本")?;
    capability_mode(&host)?;
    let artifact = artifact_for_host(&host)?;
    let cli = crate::utils::resolve_openclaw_cli_path().ok_or("未检测到内核命令")?;
    // npm 的已选 CLI 可为符号链接；固定其真实目标/字节，而非拒绝正常 npm 布局。
    // 下载包、暂存、插件目录仍独立执行无链接检查。
    let cli = fs::canonicalize(PathBuf::from(cli)).map_err(|e| e.to_string())?;
    let identity = cli_identity(&cli)?;
    let host_sdk = sdk_identity(&cli, &host, &artifact)?;
    let mut help = crate::utils::openclaw_command_async();
    if !command_pins_cli(help.as_std(), &cli) {
        return Err(failure("WEIXIN_HOST_CHANGED", "help 来源与内核不一致"));
    }
    help.args(["plugins", "install", "--help"]);
    let (exit, help, _) =
        bounded_process(&mut help, None, Duration::from_secs(30), OUTPUT_MAX).await?;
    if !exit.success() {
        return Err(failure(
            "WEIXIN_LEGACY_UNSUPPORTED",
            "实际 CLI help 读取失败",
        ));
    }
    validate_cli_help(&host, &String::from_utf8_lossy(&help))?;
    let status = super::messaging::get_channel_plugin_status(PLUGIN_ID.into()).await?;
    let extension = managed_path(
        &root,
        Path::new(status["path"].as_str().unwrap_or_default()),
    )?;
    let installed = status["installed"].as_bool() == Some(true);
    if !installed && extension.exists() {
        return Err(failure(
            "WEIXIN_HOST_CHANGED",
            "已有未识别插件目录，保留原状",
        ));
    }
    if status["builtin"].as_bool() == Some(true) {
        return Err(failure("WEIXIN_HOST_CHANGED", "不替换内置插件"));
    }
    let (installed_version, installed_sha256) = if installed {
        let package = read_file(&extension.join("package.json"), COMPRESSED_MAX)?;
        let p: Value = serde_json::from_slice(&package).map_err(|_| "既有 package.json 无效")?;
        let version = p["version"].as_str().ok_or("既有插件版本缺失")?.to_string();
        prior_state(&host, Some(&version))?;
        if p["name"] != PACKAGE_NAME {
            return Err(failure("WEIXIN_HOST_CHANGED", "既有插件包身份不符"));
        }
        let manifest = read_file(&extension.join("openclaw.plugin.json"), COMPRESSED_MAX)?;
        let mut identity = package;
        identity.extend(manifest);
        (Some(version), Some(sha256(&identity)))
    } else {
        (None, None)
    };
    if (operation == "install") == installed {
        return Err(failure(
            "WEIXIN_HOST_CHANGED",
            "安装状态与操作类型不符，请重新准备",
        ));
    }
    let cfg_path = root.join("openclaw.json");
    let cfg = if cfg_path.exists() {
        read_file(&cfg_path, UNPACKED_MAX)?
    } else {
        b"{}".to_vec()
    };
    // 不调用带自愈/迁移写回的通用读取器；未确认时只读原始配置字节。
    let parsed: Value = serde_json::from_slice(&cfg)
        .map_err(|_| failure("WEIXIN_HOST_CHANGED", "原配置不是严格JSON，请先修复配置"))?;
    let protected = protected_config_for(&parsed, &host);
    let prior = prior_state(&host, installed_version.as_deref())?;
    let binding = Binding {
        caller,
        operation: operation.into(),
        host_version: host,
        host_cli: identity,
        config_sha256: sha256(&cfg),
        installed_version,
        installed_path: extension.to_string_lossy().into_owned(),
        installed_sha256,
        artifact,
        host_sdk,
    };
    Ok(Snapshot {
        binding,
        root,
        extension,
        cli,
        protected_config: protected,
        prior,
    })
}

async fn read_pipe(
    mut pipe: impl tokio::io::AsyncRead + Unpin,
    max: usize,
) -> Result<Vec<u8>, String> {
    use tokio::io::AsyncReadExt;
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = pipe.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(out);
        }
        if out.len() + n > max {
            return Err("命令输出超过预算".into());
        }
        out.extend_from_slice(&buf[..n]);
    }
}
async fn bounded_process(
    command: &mut tokio::process::Command,
    input: Option<&[u8]>,
    timeout: Duration,
    max: usize,
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>), String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|e| format!("启动命令失败: {e}"))?;
    let stdout = child.stdout.take().ok_or("命令 stdout 缺失")?;
    let stderr = child.stderr.take().ok_or("命令 stderr 缺失")?;
    let stdin = child.stdin.take();
    let result = tokio::time::timeout(timeout, async {
        let write = async {
            if let (Some(mut pipe), Some(data)) = (stdin, input) {
                pipe.write_all(data).await.map_err(|e| e.to_string())?;
                pipe.shutdown().await.map_err(|e| e.to_string())?;
            }
            Ok::<_, String>(())
        };
        let status = async { child.wait().await.map_err(|e| e.to_string()) };
        futures_util::future::try_join4(
            read_pipe(stdout, max),
            read_pipe(stderr, max),
            status,
            write,
        )
        .await
    })
    .await;
    match result {
        Ok(Ok((out, err, status, ()))) => Ok((status, out, err)),
        other => {
            let _ = tokio::time::timeout(Duration::from_secs(2), child.kill()).await;
            match other {
                Ok(Err(e)) => Err(e),
                _ => Err("命令超过时间预算，已终止受管子进程".into()),
            }
        }
    }
}
async fn inspect_compressed(
    archive: &[u8],
    artifact: &Artifact,
) -> Result<ValidatedReview, String> {
    verify_compressed_for(archive, artifact)?;
    let node = super::config::check_node()?;
    let path = node["path"]
        .as_str()
        .filter(|_| node["installed"].as_bool() == Some(true))
        .ok_or("需要已安装的 Node.js 进行静态解压")?;
    let mut command = tokio::process::Command::new(path);
    command.args(["--max-old-space-size=32", "--input-type=commonjs", "-e", "const f=require('node:fs'),z=require('node:zlib');const b=f.readFileSync(0);if(b.length>1048576)throw Error('compressed-budget');process.stdout.write(z.gunzipSync(b,{maxOutputLength:4194304}))"])
        .env("PATH", super::enhanced_path()).env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    let (status, tar, _) = bounded_process(
        &mut command,
        Some(archive),
        Duration::from_secs(15),
        UNPACKED_MAX,
    )
    .await?;
    if !status.success() {
        return Err(failure("WEIXIN_UNSAFE_ARTIFACT", "静态解压失败"));
    }
    review_tar_for(&tar, artifact)
}
async fn download(artifact: &Artifact) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .gzip(false)
        .brotli(false)
        .deflate(false)
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(artifact.url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if response.url().as_str() != artifact.url
        || response
            .content_length()
            .is_some_and(|n| n > COMPRESSED_MAX as u64)
    {
        return Err(failure("WEIXIN_UNSAFE_ARTIFACT", "来源变化或下载超限"));
    }
    let mut data = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(part) = stream.next().await {
        let part = part.map_err(|e| e.to_string())?;
        if data.len() + part.len() > COMPRESSED_MAX {
            return Err(failure("WEIXIN_UNSAFE_ARTIFACT", "下载超过预算"));
        }
        data.extend_from_slice(&part);
    }
    verify_compressed_for(&data, artifact)?;
    Ok(data)
}
struct Stage {
    directory: PathBuf,
    archive: PathBuf,
}
impl Stage {
    fn new(root: &Path, bytes: &[u8], artifact: &Artifact) -> Result<Self, String> {
        verify_compressed_for(bytes, artifact)?;
        ensure_no_links(root)?;
        let mut nonce = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let directory = root.join(format!(".clawpanel-weixin-consent-{}", sha256(&nonce)));
        let builder = fs::DirBuilder::new();
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = builder;
            builder.mode(0o700);
            builder
        };
        builder.create(&directory).map_err(|e| e.to_string())?;
        let stage = Self {
            archive: directory.join(format!("{}.tgz", artifact.sha256)),
            directory,
        };
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&stage.archive).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        verify_compressed_for(&read_file(&stage.archive, COMPRESSED_MAX)?, artifact)?;
        Ok(stage)
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        if ensure_no_links(&self.directory).is_ok() {
            let _ = fs::remove_file(&self.archive);
            let _ = fs::remove_dir(&self.directory);
        }
    }
}
#[cfg(test)]
fn check_readback(
    root: &Path,
    status: &Value,
    package: &Value,
    inventory: &Value,
    config: &Value,
) -> Result<Value, String> {
    check_readback_for(root, status, package, inventory, config, &ARTIFACT_249)
}
fn check_readback_for(
    root: &Path,
    status: &Value,
    package: &Value,
    inventory: &Value,
    config: &Value,
    artifact: &Artifact,
) -> Result<Value, String> {
    let key = crate::utils::canonicalize_path_for_safety(root, "回读根目录")
        .map(|p| crate::utils::path_compare_key(&p))?;
    let matches = |v: &Value| {
        v.as_str().is_some_and(|p| {
            let path = Path::new(p);
            ensure_no_links(path).is_ok()
                && crate::utils::canonicalize_path_for_safety(path, "回读路径")
                    .is_ok_and(|p| crate::utils::path_compare_key(&p) == key)
        })
    };
    let rows = inventory["plugins"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter(|p| p["id"] == PLUGIN_ID)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let sdk = if rows.len() == 1 {
        rows.first().copied()
    } else {
        None
    };
    let valid = status["installed"].as_bool() == Some(true)
        && matches(&status["path"])
        && package["name"] == PACKAGE_NAME
        && package["version"] == artifact.version
        && sdk.is_some_and(|p| {
            p["version"] == artifact.version
                && matches(&p["rootDir"])
                && p["status"] == "loaded"
                && p["enabled"].as_bool() == Some(true)
                && p["dependencyStatus"]["requiredInstalled"].as_bool() != Some(false)
                && p["dependencyStatus"]["missing"]
                    .as_array()
                    .is_none_or(|v| v.is_empty())
                && p["channelIds"]
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|id| id == PLUGIN_ID))
        })
        && config["plugins"]["entries"][PLUGIN_ID]["enabled"].as_bool() == Some(true)
        // 新版安装记录已迁出配置；路径必须由真实SDK注册表及磁盘状态交叉验证。
        // 旧配置若仍含本插件安装记录，则逐项验证，不接受矛盾记录。
        && config["plugins"].get("installs").is_none_or(Value::is_object)
        && config["plugins"]["installs"].get(PLUGIN_ID).is_none_or(|record|
            record["version"] == artifact.version && matches(&record["installPath"]));
    if !valid {
        return Err(failure(
            "WEIXIN_READBACK_FAILED",
            "exit0 后版本、路径、SDK loaded 或配置回读未全部成立",
        ));
    }
    Ok(
        json!({"installed":true,"version":artifact.version,"path":root.to_string_lossy(),"enabled":true,"sdkLoaded":true,"configVerified":true}),
    )
}
fn verify_installed_files(root: &Path, checks: &[FileCheck]) -> Result<(), String> {
    for check in checks {
        let path = root.join(&check.relative_path);
        let data = read_file(&path, COMPRESSED_MAX)?;
        if data.len() != check.size || sha256(&data) != check.sha256 {
            return Err(failure(
                "WEIXIN_READBACK_FAILED",
                "安装文件与已确认 artifact 字节不一致",
            ));
        }
    }
    Ok(())
}
fn redacted_output(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(16_384)]);
    let pattern = regex::Regex::new(
        r#"(?i)(api[_-]?key|token|secret|password|authorization)(\s*[:=]\s*)[^\s,;]+"#,
    )
    .expect("固定脱敏模式");
    pattern.replace_all(&text, "$1$2[REDACTED]").into_owned()
}

pub(super) async fn prepare(
    window: &tauri::WebviewWindow,
    operation: String,
) -> Result<Value, String> {
    let caller = native_caller(window)?;
    let _guard = super::messaging::CHANNEL_PLUGIN_INSTALL_LOCK
        .try_lock()
        .map_err(|_| failure("WEIXIN_BUSY", "已有插件操作进行中"))?;
    let state = snapshot(caller.clone(), &operation).await?;
    let artifact = state.binding.artifact;
    let archive = download(&artifact).await?;
    let mut review = inspect_compressed(&archive, &artifact).await?.public;
    let fresh = snapshot(caller.clone(), &operation).await?;
    if native_caller(window)? != caller || fresh.binding != state.binding {
        return Err(failure(
            "WEIXIN_HOST_CHANGED",
            "准备期间窗口或内核状态发生变化",
        ));
    }
    if state.binding.installed_sha256.is_some() {
        let previous = read_file(
            &state.extension.join("openclaw.plugin.json"),
            COMPRESSED_MAX,
        )?;
        if [ARTIFACT_249, ARTIFACT_2410]
            .iter()
            .any(|a| validate_manifest_for(&previous, a).is_ok())
        {
            review["previousDeclared"] = declared_surface();
            review["addedDeclared"] = json!({});
        }
    }
    let mode = capability_mode(&state.binding.host_version)?;
    let host = state.binding.host_version.clone();
    let installed = state.binding.installed_version.clone();
    let ticket =
        STORE
            .lock()
            .map_err(|_| "确认状态锁异常")?
            .issue(state.binding, archive, now_ms())?;
    let mut value = serde_json::to_value(ticket).map_err(|e| e.to_string())?;
    let obj = value.as_object_mut().ok_or("确认结果无效")?;
    obj.insert("kind".into(), json!("weixin-install-consent"));
    obj.insert("protocolVersion".into(), json!(1));
    obj.insert("operation".into(), json!(operation));
    obj.insert("hostVersion".into(), json!(host));
    obj.insert("installedVersion".into(), json!(installed));
    obj.insert("capabilityMode".into(), json!(mode));
    let mut public_artifact = serde_json::to_value(artifact).map_err(|e| e.to_string())?;
    public_artifact["packageName"] = json!(PACKAGE_NAME);
    obj.insert("artifact".into(), public_artifact);
    obj.insert("repairingIncompatible".into(), json!(state.prior.repairing));
    obj.insert("priorCompatibility".into(), state.prior.public);
    obj.insert("review".into(), review);
    Ok(value)
}
pub(super) async fn confirm(
    window: &tauri::WebviewWindow,
    operation_id: String,
    confirmation_token: String,
    accepted: bool,
    artifact_sha256: String,
    review_token: String,
) -> Result<Value, String> {
    if !accepted {
        return Err(consent_required());
    }
    let caller = native_caller(window)?;
    let _guard = super::messaging::CHANNEL_PLUGIN_INSTALL_LOCK
        .try_lock()
        .map_err(|_| failure("WEIXIN_BUSY", "已有插件操作进行中"))?;
    let operation = STORE
        .lock()
        .map_err(|_| "确认状态锁异常")?
        .lookup(&caller, &operation_id, &confirmation_token, now_ms())?
        .binding
        .operation
        .clone();
    let state = snapshot(caller.clone(), &operation).await?;
    let approval = Approval {
        operation_id: operation_id.clone(),
        confirmation_token,
        accepted,
        artifact_sha256,
        review_token,
    };
    let pending =
        STORE
            .lock()
            .map_err(|_| "确认状态锁异常")?
            .claim(&state.binding, &approval, now_ms())?;
    let artifact = pending.binding.artifact;
    let review = inspect_compressed(&pending.archive, &artifact).await?;
    let fresh = snapshot(caller.clone(), &operation).await?;
    if native_caller(window)? != caller || fresh.binding != pending.binding {
        return Err(failure(
            "WEIXIN_HOST_CHANGED",
            "确认后窗口或内核状态发生变化",
        ));
    }
    let stage = Stage::new(&state.root, &pending.archive, &artifact)?;
    if now_ms() >= pending.expires_ms {
        return Err(failure("WEIXIN_EXPIRED", "执行前确认已过期"));
    }
    let args = install_arguments(
        &stage.archive,
        capability_mode(&state.binding.host_version)?,
        &operation,
    )?;
    let _ = window.emit_to(
        window.label(),
        "channel-action-progress",
        json!({"platform":"weixin","action":"install","operationId":operation_id,"progress":5}),
    );
    let mut command = host_command(&state)?;
    command.args(&args);
    let (exit, stdout, stderr) =
        bounded_process(&mut command, None, Duration::from_secs(600), OUTPUT_MAX)
            .await
            .map_err(|e| failure("WEIXIN_INSTALL_FAILED", &e))?;
    let output = format!("{}\n{}", redacted_output(&stdout), redacted_output(&stderr));
    for line in output.lines().take(128) {
        let _ = window.emit_to(window.label(), "channel-action-log", json!({"platform":"weixin","action":"install","operationId":operation_id,"message":line,"kind":"info"}));
    }
    if !exit.success() {
        return Err(failure(
            "WEIXIN_INSTALL_FAILED",
            &format!("CLI {exit}: {output}"),
        ));
    }
    let status = super::messaging::get_channel_plugin_status(PLUGIN_ID.into()).await?;
    let actual_root = managed_path(
        &state.root,
        Path::new(status["path"].as_str().unwrap_or_default()),
    )?;
    let package: Value = serde_json::from_slice(&read_file(
        &actual_root.join("package.json"),
        COMPRESSED_MAX,
    )?)
    .map_err(|e| e.to_string())?;
    if package["name"] != PACKAGE_NAME || package["version"] != artifact.version {
        return Err(failure("WEIXIN_READBACK_FAILED", "安装后包身份不匹配"));
    }
    validate_manifest_for(
        &read_file(&actual_root.join("openclaw.plugin.json"), COMPRESSED_MAX)?,
        &artifact,
    )?;
    verify_installed_files(&actual_root, &review.file_checks)?;
    let after: Value =
        serde_json::from_slice(&read_file(&state.root.join("openclaw.json"), UNPACKED_MAX)?)
            .map_err(|_| failure("WEIXIN_READBACK_FAILED", "配置回读JSON无效"))?;
    if protected_config_for(&after, &state.binding.host_version) != state.protected_config {
        return Err(failure("WEIXIN_READBACK_FAILED", "非插件配置发生变化"));
    }
    let mut enable = host_command(&state)?;
    enable.args(["plugins", "enable", PLUGIN_ID]);
    let (exit, out, err) =
        bounded_process(&mut enable, None, Duration::from_secs(30), OUTPUT_MAX).await?;
    if !exit.success() {
        return Err(failure(
            "WEIXIN_READBACK_FAILED",
            &format!(
                "上游启用策略未通过: {} {}",
                redacted_output(&out),
                redacted_output(&err)
            ),
        ));
    }
    let mut list = host_command(&state)?;
    list.args(["plugins", "list", "--json"]);
    let (exit, inventory, errors) =
        bounded_process(&mut list, None, Duration::from_secs(60), OUTPUT_MAX).await?;
    if !exit.success() {
        return Err(failure("WEIXIN_READBACK_FAILED", &redacted_output(&errors)));
    }
    let start = inventory
        .iter()
        .position(|b| *b == b'{')
        .ok_or_else(|| failure("WEIXIN_READBACK_FAILED", "SDK注册表缺JSON对象"))?;
    let inventory: Value = serde_json::from_slice(&inventory[start..])
        .map_err(|_| failure("WEIXIN_READBACK_FAILED", "实际 SDK 注册表 JSON 无效"))?;
    let config: Value =
        serde_json::from_slice(&read_file(&state.root.join("openclaw.json"), UNPACKED_MAX)?)
            .map_err(|_| failure("WEIXIN_READBACK_FAILED", "最终配置JSON无效"))?;
    if protected_config_for(&config, &state.binding.host_version) != state.protected_config {
        return Err(failure("WEIXIN_READBACK_FAILED", "非插件配置回读不一致"));
    }
    if sdk_identity(&state.cli, &state.binding.host_version, &artifact)? != state.binding.host_sdk {
        return Err(failure("WEIXIN_HOST_CHANGED", "执行期间实际SDK发生变化"));
    }
    let readback = check_readback_for(
        &actual_root,
        &status,
        &package,
        &inventory,
        &config,
        &artifact,
    )?;
    let _ = window.emit_to(
        window.label(),
        "channel-action-progress",
        json!({"platform":"weixin","action":"install","operationId":operation_id,"progress":100}),
    );
    Ok(
        json!({"ok":true,"operationId":operation_id,"version":artifact.version,"hostVersion":state.binding.host_version,"message":output,"readback":readback,"warnings":["SDK 已加载不代表微信扫码或外部消息收发已验证。"]}),
    )
}
pub(super) fn cancel(
    window: &tauri::WebviewWindow,
    operation_id: String,
    confirmation_token: String,
) -> Result<Value, String> {
    let caller = native_caller(window)?;
    STORE.lock().map_err(|_| "确认状态锁异常")?.cancel(
        &caller,
        &operation_id,
        &confirmation_token,
        now_ms(),
    )?;
    Ok(json!({"cancelled":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn binding(caller: &str) -> Binding {
        Binding {
            caller: caller.into(),
            operation: "install".into(),
            host_version: "2026.9.8".into(),
            host_cli: "fixture-host-cli".into(),
            config_sha256: "fixture-config".into(),
            installed_version: None,
            installed_path: "fixture-extension".into(),
            installed_sha256: None,
            artifact: ARTIFACT_249,
            host_sdk: "fixture-sdk".into(),
        }
    }
    fn approval(ticket: &Ticket) -> Approval {
        Approval {
            operation_id: ticket.operation_id.clone(),
            confirmation_token: ticket.confirmation_token.clone(),
            accepted: true,
            artifact_sha256: ARTIFACT_SHA256.into(),
            review_token: REVIEW_TOKEN.into(),
        }
    }

    #[test]
    fn native_origin_is_main_local_only_not_a_browser_session() {
        for url in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
        ] {
            assert!(caller_identity("main", url, false).is_ok());
            assert!(caller_identity("child", url, false).is_err());
        }
        for url in [
            "null",
            "https://example.com/",
            "http://tauri.localhost.evil/",
            "tauri://evil/",
            "http://user@tauri.localhost/",
            "http://localhost:1420/",
        ] {
            assert!(caller_identity("main", url, false).is_err(), "{url}");
        }
        assert!(caller_identity("main", "http://localhost:1420/", true).is_ok());
    }

    #[test]
    fn one_explicit_approval_only_and_replay_rejected() {
        let mut store = ConsentStore::default();
        let b = binding("main");
        let t = store.issue(b.clone(), vec![1], 100).unwrap();
        let mut a = approval(&t);
        a.accepted = false;
        assert!(store.claim(&b, &a, 101).is_err());
        a.accepted = true;
        assert!(store.claim(&b, &a, 102).is_ok());
        assert!(store
            .claim(&b, &a, 103)
            .unwrap_err()
            .contains("WEIXIN_USED"));
    }

    #[test]
    fn caller_operation_host_config_path_and_installed_bytes_are_bound() {
        let original = binding("main");
        let mut variants = Vec::new();
        let mut b = original.clone();
        b.caller = "foreign".into();
        variants.push(b);
        let mut b = original.clone();
        b.operation = "upgrade".into();
        variants.push(b);
        let mut b = original.clone();
        b.host_version = "2026.5.12".into();
        variants.push(b);
        let mut b = original.clone();
        b.host_cli.push('x');
        variants.push(b);
        let mut b = original.clone();
        b.config_sha256.push('x');
        variants.push(b);
        let mut b = original.clone();
        b.installed_path.push('x');
        variants.push(b);
        let mut b = original.clone();
        b.installed_version = Some("2.4.8".into());
        variants.push(b);
        let mut b = original.clone();
        b.installed_sha256 = Some("changed".into());
        variants.push(b);
        for changed in variants {
            let mut store = ConsentStore::default();
            let t = store.issue(original.clone(), vec![1], 0).unwrap();
            assert!(store.claim(&changed, &approval(&t), 1).is_err());
        }
    }

    #[test]
    fn changed_hash_review_token_wrong_secret_and_expiry_reject() {
        let b = binding("main");
        for field in 0..3 {
            let mut s = ConsentStore::default();
            let t = s.issue(b.clone(), vec![1], 0).unwrap();
            let mut a = approval(&t);
            match field {
                0 => a.artifact_sha256.push('0'),
                1 => a.review_token.push('0'),
                _ => a.confirmation_token.push('0'),
            }
            assert!(s.claim(&b, &a, 1).is_err());
        }
        let mut s = ConsentStore::default();
        let t = s.issue(b.clone(), vec![1], 0).unwrap();
        assert!(s
            .claim(&b, &approval(&t), TTL_MS)
            .unwrap_err()
            .contains("WEIXIN_EXPIRED"));
    }

    #[test]
    fn cancel_and_pending_budgets_and_expired_release_are_bounded() {
        let mut s = ConsentStore::default();
        let b = binding("main");
        let t = s.issue(b.clone(), vec![1], 0).unwrap();
        s.issue(b.clone(), vec![1], 0).unwrap();
        assert!(s.issue(b.clone(), vec![1], 0).is_err());
        assert!(s
            .cancel("other", &t.operation_id, &t.confirmation_token, 1)
            .is_err());
        s.cancel(&b.caller, &t.operation_id, &t.confirmation_token, 1)
            .unwrap();
        assert!(s.claim(&b, &approval(&t), 1).is_err());
        for n in 0..7 {
            s.issue(binding(&format!("caller{n}")), vec![1], 0).unwrap();
        }
        assert!(s.issue(binding("ninth"), vec![1], 0).is_err());
        assert!(s.issue(b, vec![1], TTL_MS).is_ok());
    }

    #[test]
    fn simultaneous_confirm_has_exactly_one_claim() {
        let store = Arc::new(Mutex::new(ConsentStore::default()));
        let b = binding("main");
        let ticket = store.lock().unwrap().issue(b.clone(), vec![1], 0).unwrap();
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let s = store.clone();
                let b = b.clone();
                let a = approval(&ticket);
                std::thread::spawn(move || s.lock().unwrap().claim(&b, &a, 1).is_ok())
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .map(|h| usize::from(h.join().unwrap()))
                .sum::<usize>(),
            1
        );
    }

    #[test]
    fn old_host_gets_no_new_flag_and_unknown_contract_fails_closed() {
        assert_eq!(capability_mode("2026.5.12").unwrap(), "legacy-reviewed");
        assert_eq!(capability_mode("2026.9.8-zh.1").unwrap(), "native-cli");
        for host in [
            "2026.9.8-zh.bad",
            "2026.9.8-zh.1-beta.1",
            "2026.9.9",
            "unknown",
        ] {
            assert!(capability_mode(host).is_err());
        }
        let archive = std::path::Path::new("fixture.tgz");
        let old = install_arguments(archive, "legacy-reviewed", "install").unwrap();
        assert!(!old.iter().any(|arg| arg == "--accept-capabilities"));
        // 9.8/10.4 的真实本地归档首次安装也要求确认来源；旧 5.12 不接收新参数。
        for operation in ["install", "upgrade"] {
            assert_eq!(
                install_arguments(archive, "native-cli", operation).unwrap(),
                [
                    "plugins",
                    "install",
                    "fixture.tgz",
                    "--force",
                    "--accept-capabilities"
                ]
            );
        }
        assert!(!old.iter().any(|arg| arg == "--force"));
        assert_eq!(
            install_arguments(archive, "legacy-reviewed", "upgrade").unwrap(),
            ["plugins", "install", "fixture.tgz", "--force"]
        );
        let new = install_arguments(archive, "native-cli", "upgrade").unwrap();
        assert!(new.iter().any(|arg| arg == "--accept-capabilities"));
        assert!(new.iter().any(|arg| arg == "--force"));
        assert!(new
            .iter()
            .all(|arg| !arg.contains("unsafe") && !arg.contains("latest")));
    }

    #[test]
    fn reviewed_104_is_native_but_preview_or_malformed_suffix_is_not_stable() {
        assert_eq!(capability_mode("2026.10.4").unwrap(), "native-cli");
        assert_eq!(capability_mode("2026.10.4-1-zh.2").unwrap(), "native-cli");
        for host in [
            "2026.10.4-beta.1",
            "2026.10.4-preview",
            "2026.10.4-zh.bad",
            "2026.10.4-zh.1-beta.1",
        ] {
            assert!(capability_mode(host).is_err(), "{host}");
        }
    }

    fn tar(items: &[(&str, u8, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, kind, bytes) in items {
            let mut header = [0u8; 512];
            header[..name.len()].copy_from_slice(name.as_bytes());
            let size = format!("{:011o}\0", bytes.len());
            header[124..136].copy_from_slice(size.as_bytes());
            header[156] = *kind;
            header[148..156].fill(b' ');
            let sum: u32 = header.iter().map(|b| u32::from(*b)).sum();
            header[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
            out.extend(header);
            out.extend_from_slice(bytes);
            out.resize(out.len().div_ceil(512) * 512, 0);
        }
        out.resize(out.len() + 1024, 0);
        out
    }

    #[test]
    fn archive_path_links_duplicate_headers_and_resource_limits_reject() {
        for name in [
            "../evil",
            "package/../evil",
            "/package/a",
            "package/C:/evil",
            "package/a\\b",
        ] {
            assert!(parse_tar(&tar(&[(name, b'0', b"x")])).is_err(), "{name}");
        }
        for kind in [b'1', b'2', b'x', b'g', b'6'] {
            assert!(parse_tar(&tar(&[("package/a", kind, b"x")])).is_err());
        }
        assert!(parse_tar(&tar(&[
            ("package/a", b'0', b"x"),
            ("package/a", b'0', b"y")
        ]))
        .is_err());
        assert!(parse_tar(&vec![0; UNPACKED_MAX + 1]).is_err());
        let good = tar(&[("package/a", b'0', b"hello")]);
        let mut bad = good.clone();
        bad[10] ^= 1;
        assert!(parse_tar(&bad).is_err());
        assert_eq!(parse_tar(&good).unwrap().files, 1);
    }

    #[test]
    fn changed_compressed_bytes_and_wrong_manifest_never_reviewed() {
        assert!(verify_compressed(b"not the exact artifact").is_err());
        assert!(validate_manifest(br#"{"id":"openclaw-weixin","version":"2.4.9","channels":["openclaw-weixin"],"hooks":["extra"]}"#).is_err());
        let declared = declared_surface();
        assert_eq!(declared["channels"], serde_json::json!(["openclaw-weixin"]));
        assert_eq!(declared.as_object().unwrap().len(), 10);
        assert_eq!(declared["hooks"], serde_json::json!([]));
    }

    #[test]
    fn exit_zero_alone_is_not_success_sdk_path_version_and_config_required() {
        let root = std::path::Path::new("fixture-extension");
        let status = serde_json::json!({"installed":true,"path":"fixture-extension"});
        let package = serde_json::json!({"name":PACKAGE_NAME,"version":VERSION});
        let inventory = serde_json::json!({"plugins":[{"id":"openclaw-weixin","version":VERSION,"rootDir":"fixture-extension","enabled":true,"status":"loaded","channelIds":["openclaw-weixin"]}]});
        let config = serde_json::json!({"plugins":{"entries":{"openclaw-weixin":{"enabled":true}},"installs":{"openclaw-weixin":{"version":VERSION,"installPath":"fixture-extension"}}}});
        assert!(check_readback(root, &status, &package, &inventory, &config).is_ok());
        let mut bad = inventory.clone();
        bad["plugins"][0]["status"] = serde_json::json!("error");
        assert!(check_readback(root, &status, &package, &bad, &config).is_err());
        let mut bad = inventory.clone();
        bad["plugins"][0]["rootDir"] = serde_json::json!("foreign");
        assert!(check_readback(root, &status, &package, &bad, &config).is_err());
        let mut bad = package.clone();
        bad["version"] = serde_json::json!("2.4.8");
        assert!(check_readback(root, &status, &bad, &inventory, &config).is_err());
        assert!(
            check_readback(root, &status, &package, &inventory, &serde_json::json!({})).is_err()
        );
    }

    #[test]
    fn generic_weixin_aliases_require_consent_not_a_shared_accept_boolean() {
        for package in [
            PACKAGE_NAME,
            "@tencent-weixin/openclaw-weixin@2.4.9",
            "openclaw-weixin",
            "alias@npm:@tencent-weixin/openclaw-weixin@2.4.9",
        ] {
            assert!(requires_consent(package, None));
        }
        assert!(requires_consent("other", Some("openclaw-weixin")));
        assert!(!requires_consent("@other/plugin", Some("other")));
    }

    #[test]
    fn opaque_generic_archive_url_and_npm_aliases_cannot_hide_identity() {
        for package in [
            "renamed.tgz",
            "https://example.com/renamed.tgz",
            "alias@npm:@other/plugin",
            "file:renamed.zip",
            "../renamed.tar.gz",
            "@tencent-weixin%2fopenclaw-weixin@2.4.9",
        ] {
            assert!(requires_consent(package, None), "{package}");
        }
        assert!(!requires_consent("@other/plugin@1.2.3", None));
    }

    #[test]
    fn actual_bounded_child_preserves_scanner_exit_and_enforces_output_and_timeout() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut scanner = tokio::process::Command::new("node");
            scanner.env_remove("NODE_OPTIONS").args([
                "-e",
                "process.stderr.write('upstream scanner blocked');process.exit(7)",
            ]);
            let (exit, _, stderr) =
                bounded_process(&mut scanner, None, Duration::from_secs(15), 4096)
                    .await
                    .unwrap();
            assert_eq!(exit.code(), Some(7));
            assert_eq!(stderr, b"upstream scanner blocked");
            let mut huge = tokio::process::Command::new("node");
            huge.env_remove("NODE_OPTIONS").args([
                "-e",
                "process.stdout.write(Buffer.alloc(65536));setTimeout(()=>{},60000)",
            ]);
            assert!(
                bounded_process(&mut huge, None, Duration::from_secs(15), 4096)
                    .await
                    .is_err()
            );
            let mut hang = tokio::process::Command::new("node");
            hang.env_remove("NODE_OPTIONS")
                .args(["-e", "setTimeout(()=>{},60000)"]);
            assert!(
                bounded_process(&mut hang, None, Duration::from_millis(300), 4096)
                    .await
                    .is_err()
            );
        });
    }

    #[test]
    fn install_output_redacts_credentials_without_hiding_scanner_failure() {
        let text = redacted_output(
            b"upstream scanner blocked\napi_key=fixture-secret\nAuthorization:Bearer-secret",
        );
        assert!(text.contains("upstream scanner blocked"));
        assert!(!text.contains("fixture-secret"));
        assert!(!text.contains("Bearer-secret"));
    }

    #[test]
    fn actual_help_must_match_reviewed_host_not_a_user_supplied_mode() {
        for host in ["2026.9.8", "2026.10.4-1-zh.2"] {
            assert_eq!(
                validate_cli_help(host, "--force --accept-capabilities").unwrap(),
                "native-cli"
            );
            assert!(validate_cli_help(host, "--force").is_err());
        }
        assert_eq!(
            validate_cli_help("2026.5.12", "--force").unwrap(),
            "legacy-reviewed"
        );
        assert!(validate_cli_help("2026.5.12", "--force --accept-capabilities").is_err());
        assert!(validate_cli_help("2026.10.4-beta.1", "--force --accept-capabilities").is_err());
    }

    #[test]
    fn command_resolution_must_still_point_to_the_bound_cli() {
        let executable = std::env::current_exe().unwrap();
        let same = std::process::Command::new(&executable);
        assert!(command_pins_cli(&same, &executable));
        assert!(!command_pins_cli(
            &std::process::Command::new("not-the-bound-cli"),
            &executable
        ));
        #[cfg(windows)]
        {
            let mut wrapped = std::process::Command::new("cmd");
            wrapped.arg("/c").arg(&executable);
            assert!(command_pins_cli(&wrapped, &executable));
        }
    }

    #[test]
    fn installed_same_version_but_changed_file_is_not_verified_and_is_not_repaired() {
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        let root = base.join(format!("weixin-consent-test-{}", rand::random::<u64>()));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("dist")).unwrap();
        let file = root.join("dist/x.js");
        fs::write(&file, b"original").unwrap();
        let checks = vec![FileCheck {
            relative_path: "dist/x.js".into(),
            sha256: sha256(b"original"),
            size: 8,
        }];
        assert!(verify_installed_files(&root, &checks).is_ok());
        fs::write(&file, b"modified").unwrap();
        assert!(verify_installed_files(&root, &checks).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"modified");
        assert_eq!(
            fs::canonicalize(&root).unwrap().parent(),
            Some(base.as_path())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn non_plugin_configuration_must_remain_identical_after_install() {
        let old = json!({"gateway":{"auth":{"token":"fixture"}},"channels":{"other":{"enabled":true}},"plugins":{}});
        let mut next = old.clone();
        next["plugins"] = json!({"entries":{"openclaw-weixin":{"enabled":true}}});
        assert_eq!(protected_config(&old), protected_config(&next));
        next["channels"]["other"]["enabled"] = json!(false);
        assert_ne!(protected_config(&old), protected_config(&next));
    }

    #[test]
    fn v2_host_selects_exact_artifact_not_peer_minimum_or_preview() {
        for host in ["2026.5.12", "2026.9.8-1-zh.2"] {
            assert_eq!(artifact_for_host(host).unwrap().version, "2.4.9");
        }
        assert_eq!(
            artifact_for_host("v2026.10.4-1-zh.2").unwrap().version,
            "2.4.10"
        );
        for host in [
            "2026.10.5",
            "2026.11.1",
            "2026.10.4-beta.1",
            "2026.10.4-zh.1-beta.1",
            "2026.10.4-4294967296",
            "unknown",
        ] {
            assert!(artifact_for_host(host).is_err(), "{host}");
        }
    }

    #[test]
    fn v2_incompatible249_on104_requires_explicit_upgrade_without_false_healthy() {
        let prior = prior_state("2026.10.4", Some("2.4.9")).unwrap();
        assert!(prior.repairing);
        assert_eq!(prior.public["compatible"], false);
        assert!(prior.public["compatError"]
            .as_str()
            .unwrap()
            .contains("SDK"));
        assert!(!prior_state("2026.10.4", Some("2.4.10")).unwrap().repairing);
        for host in ["2026.5.12", "2026.9.8"] {
            assert!(
                prior_state(host, Some("2.4.10")).is_err(),
                "旧host不降级未核2410"
            );
        }
        assert!(prior_state("2026.10.4", Some("2.4.11")).is_err());
    }

    #[test]
    fn v2_shared_review_digest_does_not_approve_other_artifact_or_manifest() {
        let mut b = binding("main");
        b.host_version = "2026.10.4".into();
        b.artifact = ARTIFACT_2410;
        let mut s = ConsentStore::default();
        let t = s.issue(b.clone(), vec![1], 0).unwrap();
        let mut a = approval(&t);
        assert!(s.claim(&b, &a, 1).is_err());
        a.artifact_sha256 = ARTIFACT_2410.sha256.into();
        let mut changed = b.clone();
        changed.artifact.manifest_sha256 = MANIFEST_SHA256;
        assert!(s.claim(&changed, &a, 2).is_err());
        changed = b.clone();
        changed.artifact.integrity = INTEGRITY;
        assert!(s.claim(&changed, &a, 2).is_err());
        assert!(s.claim(&b, &a, 3).is_ok());
        assert!(s.claim(&b, &a, 4).is_err());
    }

    #[test]
    fn v2_cross_host_249_ticket_never_becomes2410_approval() {
        let b = binding("main");
        let mut s = ConsentStore::default();
        let t = s.issue(b.clone(), vec![1], 0).unwrap();
        let mut next = b.clone();
        next.host_version = "2026.10.4".into();
        next.artifact = ARTIFACT_2410;
        let mut a = approval(&t);
        a.artifact_sha256 = ARTIFACT_2410.sha256.into();
        assert!(s.claim(&next, &a, 1).is_err());
        assert!(s.claim(&b, &approval(&t), 2).is_ok());
    }

    #[test]
    fn v2_sdk_preflight_pins_real_manifest_export_and_file_bytes() {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("weixin-sdk-v2-{}", rand::random::<u64>()));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("dist")).unwrap();
        let manifest = json!({"name":"openclaw","version":"2026.10.4","exports":{"./plugin-sdk/temp-path":{"default":"./dist/sdk.js"}}});
        fs::write(root.join("package.json"), manifest.to_string()).unwrap();
        fs::write(root.join("dist/sdk.js"), b"export const tempPath = 1").unwrap();
        let first = inspect_sdk_root(&root, "2026.10.4", &ARTIFACT_2410).unwrap();
        assert!(inspect_sdk_root(&root, "2026.10.4", &ARTIFACT_249).is_err());
        fs::write(root.join("dist/sdk.js"), b"export const tempPath = 2").unwrap();
        assert_ne!(
            first,
            inspect_sdk_root(&root, "2026.10.4", &ARTIFACT_2410).unwrap()
        );
        let mut escaped = manifest.clone();
        escaped["exports"]["./plugin-sdk/temp-path"] = json!("./../outside.js");
        fs::write(root.join("package.json"), escaped.to_string()).unwrap();
        assert!(inspect_sdk_root(&root, "2026.10.4", &ARTIFACT_2410).is_err());
        fs::write(root.join("package.json"), manifest.to_string()).unwrap();
        assert!(inspect_sdk_root(&root, "2026.9.8", &ARTIFACT_2410).is_err());
        let mut zh = manifest;
        zh["name"] = json!("@qingchencloud/openclaw-zh");
        fs::write(root.join("package.json"), zh.to_string()).unwrap();
        assert!(inspect_sdk_root(&root, "2026.10.4", &ARTIFACT_2410).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn v2_known_metadata_changes_allowed_but_not_unknown_meta_other_plugins_or_global_allow() {
        let before = json!({"gateway":{"auth":{"token":"fixture"}},"plugins":{"entries":{"other":{"enabled":true}}}});
        let mut next = before.clone();
        next["meta"] = json!({"lastTouchedVersion":"2026.10.4","lastTouchedAt":"2026-10-17T00:00:00.000Z","migrations":{"modelPolicyAllowlist":true,"utilityModelSeparation":true}});
        next["plugins"]["entries"]["openclaw-weixin"] = json!({"enabled":true});
        next["plugins"]["installs"] = json!({"openclaw-weixin":{"version":"2.4.10"}});
        assert_eq!(
            protected_config_for(&before, "2026.10.4"),
            protected_config_for(&next, "2026.10.4")
        );
        for n in 0..4 {
            let mut bad = next.clone();
            match n {
                0 => bad["meta"]["unknown"] = json!(true),
                1 => bad["meta"]["lastTouchedVersion"] = json!("2026.9.8"),
                2 => bad["plugins"]["entries"]["other"]["enabled"] = json!(false),
                _ => bad["plugins"]["allow"] = json!(["*"]),
            };
            assert_ne!(
                protected_config_for(&before, "2026.10.4"),
                protected_config_for(&bad, "2026.10.4")
            );
        }
    }

    #[test]
    fn v2_modern_registry_path_is_authoritative_not_retired_config_install_record() {
        let root = Path::new("fixture-extension");
        let status = json!({"installed":true,"path":"fixture-extension"});
        let package = json!({"name":PACKAGE_NAME,"version":"2.4.10"});
        let inventory = json!({"plugins":[{"id":PLUGIN_ID,"version":"2.4.10","rootDir":"fixture-extension","status":"loaded","enabled":true,"channelIds":[PLUGIN_ID]}]});
        let config = json!({"plugins":{"entries":{"openclaw-weixin":{"enabled":true}}}});
        assert_eq!(
            check_readback_for(root, &status, &package, &inventory, &config, &ARTIFACT_2410)
                .unwrap()["version"],
            "2.4.10"
        );
        let mut bad = inventory.clone();
        bad["plugins"][0]["rootDir"] = json!("foreign");
        assert!(
            check_readback_for(root, &status, &package, &bad, &config, &ARTIFACT_2410).is_err()
        );
        let mut bad = config;
        bad["plugins"]["installs"] =
            json!({"openclaw-weixin":{"version":"2.4.9","installPath":"fixture-extension"}});
        assert!(
            check_readback_for(root, &status, &package, &inventory, &bad, &ARTIFACT_2410).is_err()
        );
    }
}
