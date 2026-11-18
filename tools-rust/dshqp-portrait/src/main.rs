//! dshqp-portrait —— 纯 CPU 本地图片合成助手（无模型 / 无 GPU / 无网络）。
//!
//! 只做一件事：把「人物图」按归一化框选贴到「底图」上，可羽化边缘、可绿幕色键抠图。
//! 这是身份保持重绘链的**本地 CPU 底座**（预演/贴图合成），不是像素级换脸——
//! 换脸需要几 GB 扩散模型 + GPU，本工具不假装能做，也不下载任何东西。
//!
//! 协议（stdin 一行 JSON → stdout 一行 JSON）：
//!   in : {"op":"compose","base":"底图路径","person":"人物路径","out":"输出路径",
//!         "box":{"x":0.3,"y":0.2,"w":0.4,"h":0.6},"feather":6,
//!         "chroma":[0,255,0],"tolerance":40}
//!        box 为 0..1 归一化坐标；feather/tolerance 可省略。
//!   out: {"ok":true,"out":"...","width":W,"height":H,"engine":"dshqp-portrait-rs/0.1.0"}
//!   失败: {"ok":false,"reason":"..."}（同时 exit 1）
//!
//! 安全：本程序只按给定路径读写文件，不联网、不 spawn、不读环境变量里的凭据。
//!       路径白名单/出图目录围栏由调用方 lib/local-portrait.js 负责。

use image::imageops::FilterType;
use image::{DynamicImage, GenericImage, Rgba, RgbaImage};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

const ENGINE: &str = "dshqp-portrait-rs/0.1.0";

fn fail(reason: &str) -> ! {
    println!("{}", json!({ "ok": false, "reason": reason }));
    let _ = io::stdout().flush();
    std::process::exit(1);
}

fn num(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(0.0)
}

fn clamp01(x: f64) -> f64 {
    if x < 0.0 { 0.0 } else if x > 1.0 { 1.0 } else { x }
}

fn main() {
    let mut raw = String::new();
    if io::stdin().read_to_string(&mut raw).is_err() {
        fail("无法读取 stdin");
    }
    let spec: Value = match serde_json::from_str(raw.trim()) {
        Ok(v) => v,
        Err(e) => fail(&format!("JSON 解析失败: {}", e)),
    };
    let op = spec.get("op").and_then(Value::as_str).unwrap_or("compose");
    if op != "compose" {
        fail(&format!("不支持的操作: {}", op));
    }
    let base_path = spec.get("base").and_then(Value::as_str).unwrap_or("");
    let person_path = spec.get("person").and_then(Value::as_str).unwrap_or("");
    let out_path = spec.get("out").and_then(Value::as_str).unwrap_or("");
    if base_path.is_empty() || person_path.is_empty() || out_path.is_empty() {
        fail("base / person / out 三个路径都必须给出");
    }

    let base_img = match image::open(base_path) {
        Ok(i) => i.to_rgba8(),
        Err(e) => fail(&format!("底图读取失败: {}", e)),
    };
    let person_img = match image::open(person_path) {
        Ok(i) => i.to_rgba8(),
        Err(e) => fail(&format!("人物图读取失败: {}", e)),
    };

    let boxv = spec.get("box").unwrap_or(&Value::Null);
    let bx = clamp01(num(boxv.get("x")));
    let by = clamp01(num(boxv.get("y")));
    let bw = clamp01(num(boxv.get("w")));
    let bh = clamp01(num(boxv.get("h")));
    if bw <= 0.0 || bh <= 0.0 {
        fail("box.w / box.h 必须大于 0");
    }
    let feather = num(spec.get("feather")).max(0.0) as u32;
    let tolerance = num(spec.get("tolerance")).max(0.0) as i64;

    let base_w = base_img.width();
    let base_h = base_img.height();
    // 目标像素尺寸：框选区域占底图的比例，至少 1px。
    let nw = ((bw * base_w as f64).round() as u32).max(1);
    let nh = ((bh * base_h as f64).round() as u32).max(1);
    let mut person = if nw != person_img.width() || nh != person_img.height() {
        image::imageops::resize(&person_img, nw, nh, FilterType::Lanczos3)
    } else {
        person_img
    };

    // 可选色键抠图：把接近 chroma 的像素 alpha 归零（绿幕/蓝幕预演用）。
    if let Some(chroma) = spec.get("chroma").and_then(Value::as_array) {
        if chroma.len() >= 3 && tolerance > 0 {
            let cr = num(chroma.get(0)) as i64;
            let cg = num(chroma.get(1)) as i64;
            let cb = num(chroma.get(2)) as i64;
            let limit = tolerance.saturating_mul(3);
            for p in person.pixels_mut() {
                let d = (p[0] as i64 - cr).abs()
                    + (p[1] as i64 - cg).abs()
                    + (p[2] as i64 - cb).abs();
                if d <= limit {
                    p[3] = 0;
                }
            }
        }
    }

    // 矩形边缘羽化：距四边 < feather 的像素 alpha 线性衰减（贴图最小实现）。
    if feather > 0 {
        let fw = feather.min(nw / 2).min(nh / 2);
        if fw > 0 {
            for y in 0..nh {
                for x in 0..nw {
                    let edge = x.min(y).min(nw - 1 - x).min(nh - 1 - y);
                    if edge < fw {
                        let p = person.get_pixel_mut(x, y);
                        let scale = edge as f64 / fw as f64;
                        p[3] = (p[3] as f64 * scale).round() as u8;
                    }
                }
            }
        }
    }

    // alpha 混合到底图框选位置。
    let mut out = RgbaImage::from_pixel(base_w, base_h, Rgba([0, 0, 0, 0]));
    if out.copy_from(&base_img, 0, 0).is_err() {
        fail("复制底图失败");
    }
    let ox = (bx * base_w as f64).round() as i64;
    let oy = (by * base_h as f64).round() as i64;
    for y in 0..nh {
        let dy = oy + y as i64;
        if dy < 0 || dy >= base_h as i64 { continue; }
        for x in 0..nw {
            let dx = ox + x as i64;
            if dx < 0 || dx >= base_w as i64 { continue; }
            let src = *person.get_pixel(x, y);
            let a = src[3] as f64 / 255.0;
            if a <= 0.0 { continue; }
            if a >= 1.0 {
                out.put_pixel(dx as u32, dy as u32, src);
                continue;
            }
            let dst = *out.get_pixel(dx as u32, dy as u32);
            let blend = |s: u8, d: u8| -> u8 {
                (s as f64 * a + d as f64 * (1.0 - a)).round() as u8
            };
            out.put_pixel(dx as u32, dy as u32, Rgba([
                blend(src[0], dst[0]), blend(src[1], dst[1]), blend(src[2], dst[2]), 255,
            ]));
        }
    }

    if let Some(parent) = Path::new(out_path).parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = fs::create_dir_all(parent) {
                fail(&format!("创建输出目录失败: {}", e));
            }
        }
    }
    let saved = DynamicImage::ImageRgba8(out).save(out_path);
    if let Err(e) = saved {
        fail(&format!("保存输出失败: {}", e));
    }
    println!("{}", json!({
        "ok": true, "out": out_path, "width": base_w, "height": base_h, "engine": ENGINE
    }));
    let _ = io::stdout().flush();
    // args 占位：避免未使用警告（env 仅用于未来扩展，当前不读任何凭据）。
    let _ = env::args().count();
}
