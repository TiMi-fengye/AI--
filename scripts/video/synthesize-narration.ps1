param(
  [Parameter(Mandatory=$true)][string]$StoryboardPath,
  [Parameter(Mandatory=$true)][string]$OutputDir,
  [string]$VoiceName = 'Microsoft Huihui Desktop',
  [int]$Rate = 5
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$story = Get-Content -Raw -Encoding UTF8 -LiteralPath $StoryboardPath | ConvertFrom-Json
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetFullPath($OutputDir)) | Out-Null
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice($VoiceName)
$synth.Rate = $Rate
$synth.Volume = 100
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$records = @()
try {
  for ($i=0; $i -lt $story.scenes.Count; $i++) {
    $scene = $story.scenes[$i]
    # Complete sentences retain natural phrasing; their actual WAV lengths drive subtitle timing.
    $sentences = [regex]::Matches([string]$scene.narration, '[^。！？]+[。！？]?')
    $parts = @()
    for ($j=0; $j -lt $sentences.Count; $j++) {
      $text = $sentences[$j].Value.Trim()
      if (!$text) { continue }
      $filename = 'voice-{0:D3}-{1:D2}.wav' -f ($i+1), ($j+1)
      $outPath = [System.IO.Path]::GetFullPath((Join-Path $OutputDir $filename))
      $synth.SetOutputToWaveFile($outPath, $format)
      $synth.Speak($text)
      $synth.SetOutputToNull()
      $parts += [pscustomobject]@{text=$text; file=$filename}
    }
    $records += [pscustomobject]@{id=$scene.id; index=($i+1); parts=$parts}
    Write-Output ('NARRATION {0:D2}/{1} {2}' -f ($i+1), $story.scenes.Count, $scene.id)
  }
  [pscustomobject]@{voice=$VoiceName; engine='Windows System.Speech'; rate=$Rate; sampleRate=24000; scenes=$records} |
    ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $OutputDir 'narration.json')
} finally { $synth.Dispose() }
