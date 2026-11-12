# -*- coding: utf-8 -*-
"""
把 apps/mobile 打包成 Android APK（不依赖 Gradle）。

用法：python build_apk.py
依赖：JAVA_HOME 指向 JDK 17；ANDROID_SDK 指向含 platforms/android-33 与 build-tools/33.0.2 的目录。
默认从 %TEMP%\\daygrid-build\\android 下找。
"""

import os
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
MOBILE = os.path.normpath(os.path.join(ROOT, "..", "mobile"))
TMP = os.environ.get("TEMP", "/tmp")
SDK = os.environ.get("ANDROID_SDK", os.path.join(TMP, "daygrid-build", "android", "sdk"))
JDK = ""
_cands = [os.environ.get("JAVA_HOME", "")]
_jbase = os.path.join(TMP, "daygrid-build", "android", "jdk")
if os.path.isdir(_jbase):
    for _d in sorted(os.listdir(_jbase)):
        _cands.append(os.path.join(_jbase, _d))
for _c in _cands:
    if _c and os.path.exists(os.path.join(_c, "bin", "javac.exe")):
        JDK = _c
        break
if not JDK:
    raise SystemExit("找不到 JDK（需要 javac），请设置 JAVA_HOME")
WORK = os.path.join(TMP, "daygrid-build", "apkbuild")
BT = os.environ.get("BUILD_TOOLS", os.path.join(SDK, "build-tools", "33.0.2"))
PLATFORM = os.path.join(SDK, "platforms", "android-33", "android.jar")
OUT = os.path.join(ROOT, "日格.apk")


def run(cmd, cwd=WORK):
    print(">>", " ".join(cmd[:3]), "...")
    env = dict(os.environ)
    env["JAVA_HOME"] = JDK
    env["PATH"] = os.path.join(JDK, "bin") + os.pathsep + env.get("PATH", "")
    r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print(r.stdout[-3000:])
        print(r.stderr[-3000:])
        raise SystemExit("FAILED: " + cmd[0])
    return r.stdout


def main():
    for p in (JDK, BT, PLATFORM):
        if not os.path.exists(p):
            raise SystemExit("缺少构建依赖: " + p)

    if os.path.isdir(WORK):
        shutil.rmtree(WORK)
    os.makedirs(WORK)
    for name in ("AndroidManifest.xml", "src", "res"):
        src = os.path.join(ROOT, name)
        dst = os.path.join(WORK, name)
        if not os.path.exists(src):
            continue
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)

    # 资源：名称 + 图标
    os.makedirs(os.path.join(WORK, "res", "values"), exist_ok=True)
    with open(os.path.join(WORK, "res", "values", "strings.xml"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources><string name="app_name">日格</string></resources>\n')
    mip = os.path.join(WORK, "res", "mipmap-xxxhdpi")
    os.makedirs(mip, exist_ok=True)
    shutil.copy2(os.path.join(MOBILE, "icons", "icon-192.png"), os.path.join(mip, "ic_launcher.png"))

    # 前端资源
    shutil.copytree(MOBILE, os.path.join(WORK, "assets", "www"))

    aapt2 = os.path.join(BT, "aapt2.exe")
    java = os.path.join(JDK, "bin", "java.exe")
    d8_cp = os.path.join(BT, "lib", "*")
    zipalign = os.path.join(BT, "zipalign.exe")
    keytool = os.path.join(JDK, "bin", "keytool.exe")
    javac = os.path.join(JDK, "bin", "javac.exe")

    run([aapt2, "compile", "--dir", "res", "-o", "compiled.zip"])
    run([aapt2, "link", "-o", "base.apk", "-I", PLATFORM, "--manifest", "AndroidManifest.xml",
         "--java", "gen", "-A", "assets", "--min-sdk-version", "24", "--target-sdk-version", "33", "compiled.zip"])
    run([javac, "-source", "8", "-target", "8", "-encoding", "UTF-8", "-classpath", PLATFORM,
         "-d", "classes", os.path.join("gen", "com", "daygrid", "app", "R.java"),
         os.path.join("src", "com", "daygrid", "app", "MainActivity.java")])
    os.makedirs(os.path.join(WORK, "dex"), exist_ok=True)
    run([java, "-cp", d8_cp, "com.android.tools.r8.D8", "--lib", PLATFORM, "--min-api", "24", "--output", "dex",
         os.path.join("classes", "com", "daygrid", "app", "MainActivity.class"),
         os.path.join("classes", "com", "daygrid", "app", "R.class")])

    # classes.dex 塞进 APK
    with zipfile.ZipFile(os.path.join(WORK, "base.apk"), "a", zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(WORK, "dex", "classes.dex"), "classes.dex")

    run([zipalign, "-f", "4", "base.apk", "aligned.apk"])

    ks = os.path.join(ROOT, "daygrid.keystore")
    if not os.path.exists(ks):
        run([keytool, "-genkeypair", "-keystore", ks, "-alias", "daygrid", "-keyalg", "RSA",
             "-keysize", "2048", "-validity", "10000", "-storepass", "daygrid123",
             "-keypass", "daygrid123", "-dname", "CN=DayGrid, OU=Personal, O=DayGrid, C=CN"])

    run([java, "-cp", os.path.join(BT, "lib", "*"), "com.android.apksigner.ApkSignerTool",
         "sign", "--ks", ks, "--ks-pass", "pass:daygrid123", "--key-pass", "pass:daygrid123",
         "--out", os.path.join(WORK, "daygrid.apk"), "aligned.apk"])
    run([java, "-cp", os.path.join(BT, "lib", "*"), "com.android.apksigner.ApkSignerTool",
         "verify", "--print-certs", os.path.join(WORK, "daygrid.apk")])

    shutil.copy2(os.path.join(WORK, "daygrid.apk"), OUT)
    size = os.path.getsize(OUT) / 1024 / 1024
    print("OK -> %s (%.1f MB)" % (OUT, size))


if __name__ == "__main__":
    main()
