use cargo_lock::Lockfile;
use std::env;
use std::path::{Path, PathBuf};

fn lockfile_path(manifest_dir: &Path) -> PathBuf {
    let package_lockfile = manifest_dir.join("Cargo.lock");
    if package_lockfile.is_file() {
        return package_lockfile;
    }

    let workspace_lockfile = manifest_dir.join("../Cargo.lock");
    if workspace_lockfile.is_file() {
        return workspace_lockfile;
    }

    panic!(
        "could not find Cargo.lock in {} or its parent directory",
        manifest_dir.display()
    );
}

fn main() {
    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set by Cargo"),
    );
    let lockfile_path = lockfile_path(&manifest_dir);

    println!("cargo:rerun-if-changed={}", lockfile_path.display());

    let lockfile = Lockfile::load(&lockfile_path)
        .unwrap_or_else(|error| panic!("failed to load {}: {error}", lockfile_path.display()));
    let mut lingua_packages = lockfile
        .packages
        .iter()
        .filter(|package| package.name.as_str() == "lingua");
    let lingua = lingua_packages.next().unwrap_or_else(|| {
        panic!(
            "could not find the lingua package in {}",
            lockfile_path.display()
        )
    });

    assert!(
        lingua_packages.next().is_none(),
        "found multiple lingua packages in {}",
        lockfile_path.display()
    );

    println!("cargo:rustc-env=LINGUA_VERSION={}", lingua.version);
}
