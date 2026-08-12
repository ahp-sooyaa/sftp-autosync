# Stable installs: use npm/bun global install after publishing.
# For brew HEAD while developing the tap:
#   brew install --HEAD ahp-sooyaa/sftp-autosync/sftp-autosync
#
# When tagging v0.2.0+, switch to a tarball url + sha256:
#   curl -L https://github.com/ahp-sooyaa/sftp-autosync/archive/refs/tags/v0.2.0.tar.gz | shasum -a 256

class SftpAutosync < Formula
  desc "Valet-style SFTP auto-sync for macOS"
  homepage "https://github.com/ahp-sooyaa/sftp-autosync"
  head "https://github.com/ahp-sooyaa/sftp-autosync.git", branch: "main"
  license "MIT"

  depends_on "oven-sh/bun/bun"

  def install
    system "bun", "install", "--production"
    libexec.install Dir["*"]
    (bin/"sftp-autosync").write <<~EOS
      #!/bin/bash
      exec "#{Formula["bun"].opt_bin}/bun" "#{libexec}/bin/sftp-autosync.js" "$@"
    EOS
  end

  test do
    assert_match "sftp-autosync", shell_output("#{bin}/sftp-autosync help")
  end
end
