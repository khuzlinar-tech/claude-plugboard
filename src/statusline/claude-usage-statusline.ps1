# Claude Code status line — Claude Profile Manager
# script-version: 1
#
# Claude Code runs this on every session event and pipes it a JSON document on
# stdin (model, workspace, context window, and for Pro/Max accounts the exact
# rate-limit windows). Whatever is printed to stdout becomes the status line.
#
# Two things happen here:
#   1. a status line is composed from that JSON and from state.json, which the
#      app writes next to this script — every display choice and every piece of
#      translated text comes from there, so this file stays generic;
#   2. when Claude Code supplies rate limits, they are recorded in bridge.json.
#      Those figures are exact and carry a real reset time, which is otherwise
#      not recoverable from anything on disk. The app reads them back.
#
# Deliberately free of non-ASCII characters: every glyph comes from state.json,
# so this file survives being read with the wrong code page.
#
# Everything is wrapped in a catch-all. A status line that fails must degrade to
# a plain line, never to an error message inside somebody's terminal.

$ErrorActionPreference = 'Stop'

function Read-JsonFile($path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  return ($text.TrimStart([char]0xFEFF) | ConvertFrom-Json)
}

try {
  try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}

  $stateFile = Join-Path $PSScriptRoot 'state.json'
  $bridgeFile = Join-Path $PSScriptRoot 'bridge.json'

  # ---------------------------------------------------------------- input

  $raw = [Console]::In.ReadToEnd()
  $j = $null
  if (-not [string]::IsNullOrWhiteSpace($raw)) { $j = $raw | ConvertFrom-Json }

  $st = Read-JsonFile $stateFile
  if ($null -eq $st) { $st = [pscustomobject]@{} }

  $segments = @('dir', 'git', 'model', 'usage', 'bar', 'reset')
  if ($st.segments) { $segments = @($st.segments) }

  function Want($name) { return ($segments -contains $name) }

  function Glyph($name, $fallback) {
    if ($st.glyphs -and $st.glyphs.$name) { return [string]$st.glyphs.$name }
    return $fallback
  }

  $sep = Glyph 'sep' ' | '
  $full = Glyph 'full' '#'
  $empty = Glyph 'empty' '.'
  $mark = Glyph 'mark' '|'
  $branch = Glyph 'branch' ''

  $labels = $true
  if ($null -ne $st.labels) { $labels = [bool]$st.labels }

  function Label($name, $fallback) {
    if (-not $labels) { return '' }
    $text = $fallback
    if ($st.labelsText -and $st.labelsText.$name) { $text = [string]$st.labelsText.$name }
    if ([string]::IsNullOrEmpty($text)) { return '' }
    return ($text + ': ')
  }

  # ---------------------------------------------------------------- colour

  $mode = 'multi'
  if ($st.color) { $mode = [string]$st.color }
  $ESC = [char]27

  function Paint($text, $kind) {
    if ($mode -eq 'none' -or [string]::IsNullOrEmpty($text)) { return $text }
    if ($mode -eq 'mono') {
      $code = '90'
    } else {
      switch ($kind) {
        'danger' { $code = '31' }
        'warn' { $code = '33' }
        'ok' { $code = '32' }
        'accent' { $code = '36' }
        default { $code = '90' }
      }
    }
    return ($ESC + '[' + $code + 'm' + $text + $ESC + '[0m')
  }

  function KindFor($pct) {
    $v = [double]$pct
    if ($v -ge 90) { return 'danger' }
    if ($v -ge 70) { return 'warn' }
    return 'ok'
  }

  # ---------------------------------------------------------------- helpers

  function Pct($n) {
    if ($null -eq $n) { return '' }
    return [string][math]::Round([double]$n)
  }

  # Ten cells of usage with the pace marker sitting at the elapsed fraction of
  # the window: bar ahead of the marker means the budget is going faster than
  # the clock.
  function Bar($pct, $elapsed) {
    $cells = 10
    $on = [math]::Min($cells, [math]::Max(0, [math]::Round([double]$pct / 100.0 * $cells)))
    $markAt = -1
    if ($null -ne $elapsed) {
      $markAt = [math]::Min($cells - 1, [math]::Max(0, [int][math]::Floor([double]$elapsed * $cells)))
    }
    $out = ''
    for ($i = 0; $i -lt $cells; $i++) {
      if ($i -eq $markAt) { $out += $mark }
      elseif ($i -lt $on) { $out += $full }
      else { $out += $empty }
    }
    return $out
  }

  function ClockOf($d) {
    # Invariant culture on purpose: several Windows locales define an empty
    # AM/PM designator, which would print "11:32" for both halves of the day.
    $ci = [System.Globalization.CultureInfo]::InvariantCulture
    if ($st.time24 -eq $false) { return ([datetime]$d).ToString('h:mm tt', $ci) }
    return ([datetime]$d).ToString('HH:mm', $ci)
  }

  function LeftOf($d) {
    $span = ([datetime]$d) - (Get-Date)
    if ($span.TotalSeconds -le 0) { return '0m' }
    # Floor, not [int]: casting to int in PowerShell rounds, which would turn
    # three hours and thirty-nine minutes into "4h 39m".
    if ($span.TotalHours -ge 24) { return ('{0}d {1}h' -f [math]::Floor($span.TotalDays), $span.Hours) }
    if ($span.TotalMinutes -ge 60) { return ('{0}h {1:00}m' -f [math]::Floor($span.TotalHours), $span.Minutes) }
    return ('{0}m' -f [math]::Floor($span.TotalMinutes))
  }

  function FromSeconds($seconds) {
    if (-not $seconds) { return $null }
    return [DateTimeOffset]::FromUnixTimeSeconds([long]$seconds).ToLocalTime().DateTime
  }

  function FromMillis($ms) {
    if (-not $ms) { return $null }
    return [DateTimeOffset]::FromUnixTimeMilliseconds([long]$ms).ToLocalTime().DateTime
  }

  function DirOf($json) {
    if ($json -and $json.workspace -and $json.workspace.current_dir) { return [string]$json.workspace.current_dir }
    if ($json -and $json.cwd) { return [string]$json.cwd }
    return $null
  }

  # ------------------------------------------------- rate limits and bridge

  # Exact windows, when Claude Code has them: present for Pro/Max accounts once
  # the session has had a reply. Otherwise fall back to the figures the app
  # derived from plan-usage-history.json, marked approximate with a tilde.
  $rl = $null
  if ($j) { $rl = $j.rate_limits }

  $fhPct = $null
  $fhReset = $null
  $sdPct = $null
  $sdReset = $null
  $approx = ''

  if ($rl -and $null -ne $rl.five_hour -and $null -ne $rl.five_hour.used_percentage) {
    $fhPct = [double]$rl.five_hour.used_percentage
    $fhReset = FromSeconds $rl.five_hour.resets_at
  }
  if ($rl -and $null -ne $rl.seven_day -and $null -ne $rl.seven_day.used_percentage) {
    $sdPct = [double]$rl.seven_day.used_percentage
    $sdReset = FromSeconds $rl.seven_day.resets_at
  }

  if ($null -eq $fhPct -and $st.fallback -and $null -ne $st.fallback.fh) {
    $fhPct = [double]$st.fallback.fh
    $fhReset = FromMillis $st.fallback.fhResetAt
    $approx = '~'
  }
  if ($null -eq $sdPct -and $st.fallback -and $null -ne $st.fallback.sd) {
    $sdPct = [double]$st.fallback.sd
    $sdReset = FromMillis $st.fallback.sdResetAt
  }

  # Hand the exact numbers back to the app. Written only when something changed,
  # because this script runs on every assistant message.
  if ($rl -and $st.bridge -ne $false -and $st.profile -and $st.profile.org) {
    try {
      $org = [string]$st.profile.org
      $entry = [pscustomobject]@{
        at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        fh = $null
        sd = $null
        cc = $null
      }
      if ($null -ne $fhPct -and $approx -eq '') {
        $ms = $null
        if ($rl.five_hour.resets_at) { $ms = [long]$rl.five_hour.resets_at * 1000 }
        $entry.fh = [pscustomobject]@{ value = $fhPct; resetAt = $ms }
      }
      if ($null -ne $sdPct -and $approx -eq '') {
        $ms = $null
        if ($rl.seven_day.resets_at) { $ms = [long]$rl.seven_day.resets_at * 1000 }
        $entry.sd = [pscustomobject]@{ value = $sdPct; resetAt = $ms }
      }
      if ($j.version) { $entry.cc = [string]$j.version }

      $bridge = Read-JsonFile $bridgeFile
      if ($null -eq $bridge -or $null -eq $bridge.orgs) {
        $bridge = [pscustomobject]@{ version = 1; orgs = [pscustomobject]@{} }
      }

      $prev = $bridge.orgs.$org
      $changed = $true
      if ($prev) {
        $changed = ($prev.fh.value -ne $entry.fh.value) -or ($prev.fh.resetAt -ne $entry.fh.resetAt) -or
                   ($prev.sd.value -ne $entry.sd.value) -or ($prev.sd.resetAt -ne $entry.sd.resetAt)
      }

      if ($changed) {
        if ($prev) {
          $bridge.orgs.$org = $entry
        } else {
          $bridge.orgs | Add-Member -MemberType NoteProperty -Name $org -Value $entry
        }
        $tmp = ($bridgeFile + '.tmp')
        ($bridge | ConvertTo-Json -Depth 6 -Compress) | Set-Content -LiteralPath $tmp -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $bridgeFile -Force
      }
    } catch {
      # The bridge is a convenience for the app; the status line matters more.
    }
  }

  # ---------------------------------------------------------------- segments

  $parts = New-Object System.Collections.ArrayList

  if (Want 'dir') {
    $dir = DirOf $j
    if ($dir) { [void]$parts.Add((Paint (Split-Path $dir -Leaf) 'accent')) }
  }

  if (Want 'git') {
    # Read .git/HEAD directly rather than spawning git: this runs on every
    # message, and launching a process is the most expensive thing here.
    $dir = DirOf $j
    $head = $null
    while ($dir -and -not $head) {
      $candidate = Join-Path $dir '.git'
      if (Test-Path -LiteralPath $candidate -PathType Container) {
        $headFile = Join-Path $candidate 'HEAD'
        if (Test-Path -LiteralPath $headFile) { $head = (Get-Content -LiteralPath $headFile -Raw).Trim() }
        break
      }
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        # A worktree or submodule: .git is a file pointing at the real directory.
        $line = (Get-Content -LiteralPath $candidate -Raw).Trim()
        if ($line -match '^gitdir:\s*(.+)$') {
          $real = $Matches[1].Trim()
          if (-not [System.IO.Path]::IsPathRooted($real)) { $real = Join-Path $dir $real }
          $headFile = Join-Path $real 'HEAD'
          if (Test-Path -LiteralPath $headFile) { $head = (Get-Content -LiteralPath $headFile -Raw).Trim() }
        }
        break
      }
      $parent = Split-Path $dir -Parent
      if (-not $parent -or $parent -eq $dir) { break }
      $dir = $parent
    }
    if ($head) {
      if ($head -match '^ref:\s*refs/heads/(.+)$') {
        $name = $Matches[1]
      } else {
        $name = $head.Substring(0, [math]::Min(7, $head.Length))
      }
      $prefix = ''
      if ($branch) { $prefix = ($branch + ' ') }
      [void]$parts.Add((Paint ($prefix + $name) 'dim'))
    }
  }

  if ((Want 'model') -and $j -and $j.model -and $j.model.display_name) {
    [void]$parts.Add((Paint ([string]$j.model.display_name) 'dim'))
  }

  if ((Want 'profile') -and $st.profile -and $st.profile.label) {
    [void]$parts.Add((Paint ([string]$st.profile.label) 'accent'))
  }

  if ((Want 'context') -and $j -and $j.context_window -and $null -ne $j.context_window.used_percentage) {
    $ctx = [double]$j.context_window.used_percentage
    [void]$parts.Add((Label 'ctx' 'Ctx') + (Paint ((Pct $ctx) + '%') (KindFor $ctx)))
  }

  if ((Want 'usage') -and $null -ne $fhPct) {
    $text = (Label 'usage' 'Usage') + (Paint ($approx + (Pct $fhPct) + '%') (KindFor $fhPct))
    if (Want 'bar') {
      # The five-hour window ends at the reset, so the elapsed fraction — and
      # with it the pace marker — follows from the reset time alone.
      $elapsed = $null
      $wantPace = $true
      if ($null -ne $st.pace) { $wantPace = [bool]$st.pace }
      if ($wantPace -and $fhReset) {
        $span = 5.0 * 3600
        $left = (([datetime]$fhReset) - (Get-Date)).TotalSeconds
        if ($left -gt 0 -and $left -le $span) { $elapsed = (($span - $left) / $span) }
      }
      $text += ' ' + (Paint (Bar $fhPct $elapsed) (KindFor $fhPct))
    }
    [void]$parts.Add($text)
  }

  if ((Want 'weekly') -and $null -ne $sdPct) {
    [void]$parts.Add((Label 'week' 'Week') + (Paint ($approx + (Pct $sdPct) + '%') (KindFor $sdPct)))
  }

  # A reset time already in the past means the window has rolled over and the
  # figures are stale, so it is left out rather than shown as "0m".
  if ((Want 'reset') -and $fhReset -and (([datetime]$fhReset) -gt (Get-Date))) {
    [void]$parts.Add((Label 'reset' 'Reset') + (Paint ((ClockOf $fhReset) + ' (' + (LeftOf $fhReset) + ')') 'dim'))
  }

  if ((Want 'cost') -and $j -and $j.cost -and $null -ne $j.cost.total_cost_usd) {
    # The figure is in dollars, so it is formatted in dollars regardless of the
    # machine's locale — a comma decimal separator next to a $ reads as an error.
    $usd = ([double]$j.cost.total_cost_usd).ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture)
    [void]$parts.Add((Label 'cost' 'Cost') + (Paint ('$' + $usd) 'dim'))
  }

  if ($parts.Count -eq 0) { [void]$parts.Add((Paint 'claude-profile-manager' 'dim')) }
  Write-Output ($parts -join $sep)
} catch {
  # Last resort: say who is responsible, quietly, and exit clean.
  Write-Output 'claude-profile-manager: status line unavailable'
}
