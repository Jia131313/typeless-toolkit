fn main() {
    let edition = std::env::var("TYPELESS_TOOLKIT_EDITION").unwrap_or_else(|_| "lite".to_string());
    if edition != "portable" && edition != "lite" {
        panic!("TYPELESS_TOOLKIT_EDITION must be portable or lite");
    }

    println!("cargo:rerun-if-env-changed=TYPELESS_TOOLKIT_EDITION");
    println!("cargo:rustc-env=TYPELESS_TOOLKIT_EDITION={edition}");
    tauri_build::build()
}
