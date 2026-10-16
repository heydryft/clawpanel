use base64::Engine;
use flate2::{write::ZlibEncoder, Compression};
#[cfg(test)]
use flate2::{Decompress, FlushDecompress, Status};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

const NEW_PIN: &str = "d923a5eb487a17c0a68801bba9ef0f56c81040a8";
const OLD_PIN: &str = "f97608f178d1ffeca59860195ab7da295f7c8e5f";

pub(super) fn legacy_spec(
    home: &Path,
    root: &Path,
) -> Result<Option<(PathBuf, Vec<std::ffi::OsString>)>, String> {
    let python = root.join("venv").join("Scripts").join("python.exe");
    if !cfg!(target_os = "windows") || !python.is_file() {
        return Ok(None);
    }
    let body = include_str!("../../../scripts/hermes-legacy-gateway-identity.py")
        .replace("\r\n", "\n")
        + "\n"
        + &include_str!("../../../scripts/hermes-legacy-windows-launch.py").replace("\r\n", "\n");
    let args = vec![
        "-I".into(),
        "-B".into(),
        "-c".into(),
        render(&body, "0.21.5", OLD_PIN)?.into(),
        root.as_os_str().into(),
        home.as_os_str().into(),
        OLD_PIN.into(),
        "console".into(),
        "--".into(),
    ];
    Ok(Some((python, args)))
}
const SHARED: &str = include_str!("../../../scripts/hermes-windows-script-envelope.js");
const CIM: &str = include_str!("../../../scripts/hermes-windows-cim-probe.py");
fn shared(name: &str) -> Result<String, String> {
    SHARED
        .split_once(&format!("export const {name} = String.raw`"))
        .and_then(|(_, text)| text.split_once('`'))
        .map(|(text, _)| text.replace("\r\n", "\n"))
        .ok_or_else(|| "Hermes Windows shared template contract mismatch".into())
}
fn wire(payload: &str, pin: &str, sha: &str) -> Result<String, String> {
    Ok(shared("HERMES_WINDOWS_SCRIPT_ENVELOPE")?
        .replace("__PIN__", pin)
        .replace("__SHA__", sha)
        .replace("__DATA__", payload))
}
pub(super) fn render(base: &str, version: &str, pin: &str) -> Result<String, String> {
    if !matches!((version, pin), ("0.22.2", NEW_PIN) | ("0.21.5", OLD_PIN)) || base.contains('\0') {
        return Err("Hermes Windows script contract mismatch".into());
    }
    let mut script = base.replace("\r\n", "\n");
    if version == "0.22.2" {
        let anchor = "    _hp('main_b')\n";
        let last = "\nfinally:\n";
        if !script.contains(pin)
            || script.matches(anchor).count() != 1
            || script.matches(last).count() != 1
        {
            return Err("Hermes Windows PM contract mismatch".into());
        }
        script = script
            .replacen(anchor, &(shared("HERMES_WINDOWS_CIM_INSTALL")? + anchor), 1)
            .replacen(
                last,
                "\nfinally:\n    if callable(globals().get('_cp_cim_restore')):_cp_cim_restore()\n",
                1,
            );
    } else if !script.contains(pin) || !script.contains("install_windows_cim_probe") {
        return Err("Hermes Windows legacy contract mismatch".into());
    }
    let decoder = if version == "0.22.2"
        && script.contains("install_private_gateway_identity(")
        && !script.contains("def decode_clawpanel_private_script_bytes")
    {
        let pm = include_str!("../../../scripts/hermes-pm-runtime.js");
        pm.split_once("export const HERMES_PRIVATE_SCRIPT_BYTES_DECODER = String.raw`")
            .and_then(|(_, text)| text.split_once('`'))
            .map(|(text, _)| text.replace("\r\n", "\n"))
            .ok_or("Hermes private decoder contract missing")?
    } else {
        String::new()
    };
    let raw = (CIM.replace("\r\n", "\n") + "\n" + &decoder + &script).into_bytes();
    if raw.len() > 131_072 {
        return Err("Hermes Windows source budget exceeded".into());
    }
    let sha = format!("{:x}", Sha256::digest(&raw));
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(9));
    encoder.write_all(&raw).map_err(|e| e.to_string())?;
    let data = base64::engine::general_purpose::STANDARD
        .encode(encoder.finish().map_err(|e| e.to_string())?);
    let result = wire(&data, pin, &sha)?;
    if result.len() > 30_000 {
        return Err("Hermes Windows command budget exceeded".into());
    }
    Ok(result)
}
#[cfg(test)]
fn decode(value: &str) -> Result<String, String> {
    if value.len() > 30_000 {
        return Err("Hermes envelope budget".into());
    }
    let header: Vec<_> = value
        .lines()
        .next()
        .unwrap_or_default()
        .split(' ')
        .collect();
    if header.len() != 4
        || header[0] != "#"
        || header[1] != "CLAWPANEL_PRIVATE_SCRIPT_V1"
        || ![OLD_PIN, NEW_PIN].contains(&header[2])
        || header[3].len() != 64
        || !header[3].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Hermes envelope header".into());
    }
    let data = value
        .split_once("_cp_b.b64decode('")
        .and_then(|(_, rest)| rest.split_once("',validate=True)"))
        .map(|(data, _)| data)
        .ok_or("Hermes envelope payload")?;
    if wire(data, header[2], header[3])? != value {
        return Err("Hermes envelope contract".into());
    }
    let compressed = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    let mut decoder = Decompress::new(true);
    let mut raw = Vec::with_capacity(131_073);
    let status = decoder
        .decompress_vec(&compressed, &mut raw, FlushDecompress::Finish)
        .map_err(|e| e.to_string())?;
    if status != Status::StreamEnd
        || decoder.total_in() as usize != compressed.len()
        || raw.len() > 131_072
        || format!("{:x}", Sha256::digest(&raw)) != header[3]
    {
        return Err("Hermes envelope integrity".into());
    }
    String::from_utf8(raw).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_old_new_com_body_matches_actual_node_envelope_byte_for_byte() {
        // 两端读取同一静态 helper，禁止压缩层局部绿但实际旧/新入口遗漏 worker。
        let file = PathBuf::from(file!());
        let file = if file.is_absolute() {
            file
        } else {
            Path::new(env!("CARGO_MANIFEST_DIR")).join(file)
        };
        let root = file.ancestors().nth(4).unwrap();
        let node = std::process::Command::new("node")
            .current_dir(root)
            .args(["--input-type=module", "-e", r#"
import fs from 'node:fs';
import {HERMES_PRIVATE_LAUNCH_SCRIPT as pm} from './scripts/hermes-pm-runtime.js';
import {hermesWindowsScript as render,decodeHermesWindowsScript as decode} from './scripts/hermes-windows-script-envelope.js';
const old=fs.readFileSync('scripts/hermes-legacy-gateway-identity.py','utf8').replaceAll('\r\n','\n')+'\n'+fs.readFileSync('scripts/hermes-legacy-windows-launch.py','utf8').replaceAll('\r\n','\n');
for(const [v,p,b] of [['0.22.2','d923a5eb487a17c0a68801bba9ef0f56c81040a8',pm],['0.21.5','f97608f178d1ffeca59860195ab7da295f7c8e5f',old]])
  console.log(Buffer.from(decode(render(b,{platform:'win32',version:v,pin:p})).script).toString('base64'));
"#])
            .output()
            .unwrap();
        assert!(
            node.status.success(),
            "{}",
            String::from_utf8_lossy(&node.stderr)
        );
        let output = String::from_utf8(node.stdout).unwrap();
        let lines: Vec<_> = output.lines().collect();
        assert_eq!(lines.len(), 2);
        let pm = include_str!("../../../scripts/hermes-pm-runtime.js");
        let new = pm
            .split_once("export const HERMES_PRIVATE_LAUNCH_SCRIPT = String.raw`")
            .unwrap()
            .1
            .split_once('`')
            .unwrap()
            .0
            .to_string();
        let old = include_str!("../../../scripts/hermes-legacy-gateway-identity.py")
            .replace("\r\n", "\n")
            + "\n"
            + &include_str!("../../../scripts/hermes-legacy-windows-launch.py")
                .replace("\r\n", "\n");
        for ((base, version, pin), line) in [(new, "0.22.2", NEW_PIN), (old, "0.21.5", OLD_PIN)]
            .iter()
            .zip(lines)
        {
            let wire = render(base, version, pin).unwrap();
            let raw = decode(&wire).unwrap();
            assert!(raw.contains("HERMES_WINDOWS_WMI_WORKER = r'''"));
            assert!(raw.contains("[sys.executable, '-I', '-B', '-c', HERMES_WINDOWS_WMI_WORKER]"));
            assert_eq!(
                raw.as_bytes(),
                base64::engine::general_purpose::STANDARD
                    .decode(line)
                    .unwrap()
            );
            println!(
                "COM body parity {version}: raw={}, wire={}, sha={:x}",
                raw.len(),
                wire.len(),
                Sha256::digest(raw.as_bytes())
            );
        }
    }

    fn base() -> String {
        "import os,hashlib\nPIN='d923a5eb487a17c0a68801bba9ef0f56c81040a8'\nroot=None\ndef _hp(name):pass\ndef require(value,message):assert value,message\ndef restore_policy():pass\ntry:\n    _hp('main_b')\n    print('fixture')\nfinally:\n    restore_policy()\n".into()
    }
    #[test]
    fn reviewed_source_is_bounded_and_byte_readable_without_changing_original_functions() {
        let wire = render(
            &base(),
            "0.22.2",
            "d923a5eb487a17c0a68801bba9ef0f56c81040a8",
        )
        .unwrap();
        assert!(wire.starts_with("# CLAWPANEL_PRIVATE_SCRIPT_V1 "));
        assert!(wire.len() < 20_000);
        let decoded = decode(&wire).unwrap();
        for line in base().trim().lines() {
            assert!(decoded.contains(line), "{line}");
        }
        assert!(decoded.contains("install_windows_cim_probe"));
        assert!(decoded.contains("_cp_cim_restore()"));
    }
    #[test]
    fn unknown_pins_and_missing_boundaries_fail_instead_of_unchecked_fallback() {
        assert!(render(
            &base(),
            "latest",
            "d923a5eb487a17c0a68801bba9ef0f56c81040a8"
        )
        .is_err());
        assert!(render(
            "missing anchors",
            "0.22.2",
            "d923a5eb487a17c0a68801bba9ef0f56c81040a8"
        )
        .is_err());
        assert!(render(&base(), "0.22.2", &"a".repeat(40)).is_err());
    }
    #[test]
    fn crlf_trusted_template_is_canonical_and_envelope_rejects_tampering() {
        let pin = "d923a5eb487a17c0a68801bba9ef0f56c81040a8";
        let wire = render(&base(), "0.22.2", pin).unwrap();
        assert_eq!(
            wire,
            render(&base().replace('\n', "\r\n"), "0.22.2", pin).unwrap()
        );
        assert!(decode(&(wire.clone() + "\nprint(1)")).is_err());
        assert!(decode(&wire.replacen(pin, &"a".repeat(40), 1)).is_err());
    }
    #[test]
    fn actual_pm_always_gets_the_shared_strict_decoder() {
        let pm = include_str!("../../../scripts/hermes-pm-runtime.js");
        let body = pm
            .split_once("export const HERMES_PRIVATE_LAUNCH_SCRIPT = String.raw`")
            .unwrap()
            .1
            .split_once('`')
            .unwrap()
            .0;
        let decoder = pm
            .split_once("export const HERMES_PRIVATE_SCRIPT_BYTES_DECODER = String.raw`")
            .unwrap()
            .1
            .split_once('`')
            .unwrap()
            .0;
        let raw = decode(&render(body, "0.22.2", NEW_PIN).unwrap()).unwrap();
        assert!(raw.contains(decoder));
        assert!(
            raw.find("def decode_clawpanel_private_script_bytes")
                .unwrap()
                < raw.find("_hp('main_b')").unwrap()
        );
    }
}
