#!/usr/bin/env bash
# Structural check of action.yml (actionlint only lints workflows): parses, has the expected inputs,
# drops the removed ones, every step has a shell, and every inline script passes bash -n.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

test_action_yml_structure() {
  local out; out="$(cd "$ROOT" && ruby -ryaml -e '
    a = YAML.load_file("action.yml")
    %w[command config-path forge-token forge-org forge-server-id preview-secret basic-auth-user basic-auth-password admin-email extra-env snapshot-key snapshot-secret snapshot-bucket snapshot-region github-token workspace].each { |k| abort "missing input #{k}" unless a["inputs"].key?(k) }
    %w[preview-domain db-driver test-email security-key spaces-key spaces-secret spaces-region spaces-bucket].each { |k| abort "input #{k} should be gone" if a["inputs"].key?(k) }
    abort "command must be optional" if a["inputs"]["command"]["required"]
    abort "snapshot-bucket default" unless a["inputs"]["snapshot-bucket"]["default"] == "netlife-craft-snapshots"
    abort "snapshot-region default" unless a["inputs"]["snapshot-region"]["default"] == "fra1"
    abort "basic-auth-user default" unless a["inputs"]["basic-auth-user"]["default"] == "preview"
    abort "missing output url" unless a.dig("outputs","url","value").to_s.include?("steps.run.outputs.url")
    abort "runs.using must be composite" unless a.dig("runs","using") == "composite"
    abort "uploads step should be gone" if a["runs"]["steps"].any? { |s| s["name"].to_s =~ /uploads/i }
    a["runs"]["steps"].each_with_index do |s,i|
      next unless s["run"]
      abort "step #{i} has run without shell" unless s["shell"] == "bash"
      IO.popen(["bash","-n"], "w") { |io| io.write(s["run"]) }
      abort "step #{i} (#{s["name"]}) fails bash -n" unless $?.success?
    end
    run = a["runs"]["steps"].find { |s| s["id"] == "run" }
    %w[WORKSPACE ADMIN_EMAIL SNAPSHOT_URL EXTRA_ENV].each { |k| abort "run step must pass #{k}" unless run["env"].key?(k) }
    puts "ok"
  ' 2>&1)"
  assert_eq ok "$out" "action.yml structure"
}

test_example_workflow_gates_the_job() {
  local out; out="$(cd "$ROOT" && ruby -ryaml -e '
    w = YAML.load_file("examples/client-repo/.github/workflows/preview.yml")
    cond = w.dig("jobs","preview","if").to_s
    abort "job needs a fork guard" unless cond.include?("head.repo.full_name == github.repository")
    abort "job needs the label guard" unless cond.include?("contains(github.event.pull_request.labels.*.name, '"'"'preview'"'"')")
    abort "job must still run for closed and sweep" unless cond.include?("closed") && cond.include?("pull_request")
    puts "ok"
  ' 2>&1)"
  assert_eq ok "$out" "preview.yml job if"
}

run_tests
