param(
    [Parameter(Mandatory=$true)][string]$StoryboardPath,
    [Parameter(Mandatory=$true)][string]$OutputDir,
    [Parameter(Mandatory=$true)][string]$ContactSheetPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$story = Get-Content -Raw -Encoding UTF8 -LiteralPath $StoryboardPath | ConvertFrom-Json
if (-not $story.scenes -or $story.scenes.Count -eq 0) { throw 'Storyboard contains no scenes.' }
[IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($OutputDir)) | Out-Null
$contactParent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ContactSheetPath))
[IO.Directory]::CreateDirectory($contactParent) | Out-Null

$script:W = 1920
$script:H = 1080
$script:Bg = '#071426'
$script:Panel = '#10243A'
$script:Panel2 = '#132C43'
$script:Line = '#284055'
$script:White = '#F3F8FA'
$script:Muted = '#A6BDCD'
$script:Accent = '#4FE0BF'
$script:Orange = '#FFBD73'
$script:Blue = '#83B6FF'
$script:FontCache = @{}

function Col([string]$hex) { return [Drawing.ColorTranslator]::FromHtml($hex) }
function Brush([string]$hex) { return [Drawing.SolidBrush]::new((Col $hex)) }
function Fnt([float]$size, [bool]$bold=$false, [bool]$mono=$false) {
    $key = "$size-$bold-$mono"
    if (-not $script:FontCache.ContainsKey($key)) {
        $family = if($mono) { 'Consolas' } else { 'Microsoft YaHei' }
        $style = if($bold) { [Drawing.FontStyle]::Bold } else { [Drawing.FontStyle]::Regular }
        $script:FontCache[$key] = [Drawing.Font]::new($family, $size, $style, [Drawing.GraphicsUnit]::Pixel)
    }
    return $script:FontCache[$key]
}
function Txt {
    param([string]$Text,[float]$X,[float]$Y,[float]$Width,[float]$Height,[float]$Size=32,[string]$Color=$script:White,[bool]$Bold=$false,[string]$Align='Near',[bool]$Mono=$false)
    if ([string]::IsNullOrWhiteSpace($Text)) { return }
    $format = [Drawing.StringFormat]::new()
    $format.Alignment = [Drawing.StringAlignment]::$Align
    $format.LineAlignment = [Drawing.StringAlignment]::Near
    $format.Trimming = [Drawing.StringTrimming]::EllipsisWord
    $format.FormatFlags = [Drawing.StringFormatFlags]::LineLimit
    $rect = [Drawing.RectangleF]::new($X,$Y,$Width,$Height)
    $actual = $Size
    $font = Fnt $actual $Bold $Mono
    while ($actual -gt 21) {
        $measured = $script:g.MeasureString($Text,$font,[Drawing.SizeF]::new($Width,2000),$format)
        if ($measured.Height -le ($Height + 1)) { break }
        $actual -= 1
        $font = Fnt $actual $Bold $Mono
    }
    $brush = Brush $Color
    $script:g.DrawString($Text,$font,$brush,$rect,$format)
    $brush.Dispose()
    $format.Dispose()
}
function RoundPath([float]$X,[float]$Y,[float]$Width,[float]$Height,[float]$Radius=24) {
    $path=[Drawing.Drawing2D.GraphicsPath]::new()
    $d=$Radius*2
    $path.AddArc($X,$Y,$d,$d,180,90)
    $path.AddArc(($X+$Width-$d),$Y,$d,$d,270,90)
    $path.AddArc(($X+$Width-$d),($Y+$Height-$d),$d,$d,0,90)
    $path.AddArc($X,($Y+$Height-$d),$d,$d,90,90)
    $path.CloseFigure()
    return $path
}
function Box([float]$X,[float]$Y,[float]$Width,[float]$Height,[string]$Fill=$script:Panel,[string]$Stroke=$script:Line,[float]$Radius=24) {
    $path=RoundPath $X $Y $Width $Height $Radius
    $br=Brush $Fill
    $script:g.FillPath($br,$path)
    $br.Dispose()
    if($Stroke) {
        $pen=[Drawing.Pen]::new((Col $Stroke),1.5)
        $script:g.DrawPath($pen,$path)
        $pen.Dispose()
    }
    $path.Dispose()
}
function Ln([float]$X1,[float]$Y1,[float]$X2,[float]$Y2,[string]$Color=$script:Line,[float]$Width=2) {
    $pen=[Drawing.Pen]::new((Col $Color),$Width)
    $script:g.DrawLine($pen,$X1,$Y1,$X2,$Y2)
    $pen.Dispose()
}
function Dot([float]$X,[float]$Y,[float]$R,[string]$Color) {
    $br=Brush $Color
    $script:g.FillEllipse($br,($X-$R),($Y-$R),($R*2),($R*2))
    $br.Dispose()
}
function Arrow([float]$X1,[float]$Y1,[float]$X2,[float]$Y2,[string]$Color=$script:Accent) {
    $pen=[Drawing.Pen]::new((Col $Color),3)
    $cap=[Drawing.Drawing2D.AdjustableArrowCap]::new(5,6)
    $pen.CustomEndCap=$cap
    $script:g.DrawLine($pen,$X1,$Y1,$X2,$Y2)
    $pen.Dispose()
    $cap.Dispose()
}
function Tag([string]$Text,[float]$X,[float]$Y,[float]$Width=200,[string]$Color=$script:Accent) {
    Box $X $Y $Width 44 '#153840' '#286B65' 14
    Txt $Text ($X+14) ($Y+7) ($Width-28) 32 22 $Color $true
}
function Bullets($Items,[float]$X,[float]$Y,[float]$Width,[float]$Height,[float]$Size=34,[string]$Color=$script:White) {
    $itemsArray=@($Items | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    if($itemsArray.Count -eq 0) { return }
    $slot=[Math]::Min(142,[Math]::Floor($Height/$itemsArray.Count))
    for($i=0;$i -lt $itemsArray.Count;$i++) {
        $yy=$Y+$i*$slot
        Dot ($X+7) ($yy+20) 5 $script:Accent
        Txt ([string]$itemsArray[$i]) ($X+30) $yy ($Width-30) ($slot-8) $Size $Color
    }
}
function MiniCard([string]$Label,[string]$Value,[float]$X,[float]$Y,[float]$Width=245,[float]$Height=124,[string]$Accent=$script:Accent) {
    Box $X $Y $Width $Height $script:Panel2 $script:Line 18
    Txt $Label ($X+24) ($Y+19) ($Width-48) 35 24 $script:Muted
    Txt $Value ($X+24) ($Y+59) ($Width-48) ($Height-66) 36 $Accent $true
}
function Header($Scene,[int]$Index,[int]$Total) {
    $grad=[Drawing.Drawing2D.LinearGradientBrush]::new([Drawing.Point]::new(0,0),[Drawing.Point]::new(1920,1080),(Col '#071426'),(Col '#10283D'))
    $script:g.FillRectangle($grad,0,0,$script:W,$script:H)
    $grad.Dispose()
    $grid=[Drawing.Pen]::new([Drawing.Color]::FromArgb(24,130,180,200),1)
    for($xx=0;$xx -lt $script:W;$xx+=80){$script:g.DrawLine($grid,$xx,0,$xx,945)}
    for($yy=0;$yy -lt 945;$yy+=80){$script:g.DrawLine($grid,0,$yy,1920,$yy)}
    $grid.Dispose()
    $glow=[Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(12,79,224,191))
    $script:g.FillEllipse($glow,1400,-350,900,900)
    $glow.Dispose()
    Box 78 42 70 48 $script:Accent '' 15
    Txt 'HR' 89 49 49 35 28 $script:Bg $true
    Txt '人力资源管理系统' 170 48 510 42 29 $script:White $true
    $chapter = if($Scene.chapter) { [string]$Scene.chapter } else { '系统使用与技术介绍' }
    Txt $chapter 720 50 640 40 25 $script:Muted $false 'Center'
    Txt ([string]$story.date) 1580 51 260 38 25 $script:Muted $false 'Far'
    Ln 80 112 1840 112 $script:Line 1
    $kicker=if($Scene.kicker){[string]$Scene.kicker}else{('{0:00} / {1:00}' -f $Index,$Total)}
    Txt $kicker 80 137 1700 36 24 $script:Accent $true
    Txt ([string]$Scene.title) 80 184 1760 102 60 $script:White $true
    Txt ([string]$Scene.subtitle) 84 281 1740 58 27 $script:Muted
    $footer=if(@('login','profile','personnel','leaders','attendance','hours','roles') -contains [string]$Scene.kind){'操作示意 · 演示数据'}else{'技术与流程说明 · 以当前版本配置为准'}
    Txt $footer 82 907 1470 34 22 $script:Muted
    Txt ('{0:00} / {1:00}' -f $Index,$Total) 1660 906 178 34 22 $script:Muted $false 'Far'
    Ln 80 951 1840 951 '#213A50' 1
}
function DefaultLeft($Scene,[float]$Width=780) { Bullets $Scene.bullets 92 370 $Width 480 36 }
function BrowserFrame([float]$X,[float]$Y,[float]$Width,[float]$Height,[string]$Title='HR 系统 · 操作示意') {
    Box $X $Y $Width $Height '#0D1E30' '#35516A' 24
    Box ($X+1) ($Y+1) ($Width-2) 59 '#1D354D' '' 22
    Dot ($X+26) ($Y+28) 6 '#EE9389'
    Dot ($X+48) ($Y+28) 6 '#EAC887'
    Dot ($X+70) ($Y+28) 6 $script:Accent
    Txt $Title ($X+100) ($Y+13) ($Width-125) 40 22 $script:Muted
}
function Field([string]$Label,[string]$Value,[float]$X,[float]$Y,[float]$Width=365) {
    Txt $Label $X $Y $Width 31 23 $script:Muted
    Box $X ($Y+39) $Width 62 '#17334B' '#36546B' 11
    Txt $Value ($X+16) ($Y+52) ($Width-32) 43 27 $script:White
}
function GetNodes($Scene,$Fallback) {
    if($Scene.nodes -and @($Scene.nodes).Count -gt 0) { return @($Scene.nodes) }
    return @($Fallback)
}
function RenderCover($Scene) {
    Tag '使用指南 + 开发部署' 90 369 310
    Bullets $Scene.bullets 94 454 805 350 39
    Box 1030 365 785 482 '#102C42' '#33645F' 28
    Txt '从人员档案到管理协同' 1080 410 685 65 38 $script:White $true
    $labels=@('人员资料','加班 / 请假','角色权限','开发与部署')
    for($i=0;$i -lt 4;$i++){
        $cx=1080+($i%2)*344;$cy=505+[Math]::Floor($i/2)*135
        Box $cx $cy 308 106 '#153A4B' '#2B5E6A' 20
        Txt ('0'+($i+1)) ($cx+21) ($cy+17) 65 35 25 $script:Accent $true
        Txt $labels[$i] ($cx+24) ($cy+57) 270 39 28 $script:White $true
    }
}
function RenderRoles($Scene) {
    $cards=if($Scene.cards){@($Scene.cards)}else{@(
        @{title='管理员';items=@('查看全部人员和业务信息','维护账号、角色及负责楼栋','统一配置与管理')},
        @{title='楼长';items=@('查看管理员授权的楼栋','维护本楼栋人员与考勤','范围内申请、审批与汇总')},
        @{title='普通人员';items=@('查看和维护本人资料','提交本人的加班、请假申请','查看本人的小时数')}
    )}
    for($i=0;$i -lt [Math]::Min(3,$cards.Count);$i++){
        $x=80+$i*594
        $accent=@($script:Accent,$script:Blue,$script:Orange)[$i]
        Box $x 365 570 488 $script:Panel $script:Line 26
        Tag ('角色 0'+($i+1)) ($x+32) 397 150 $accent
        Txt ([string]$cards[$i].title) ($x+31) 469 505 68 45 $accent $true
        Ln ($x+32) 550 ($x+536) 550 $script:Line
        Bullets $cards[$i].items ($x+34) 585 505 232 31
    }
}
function RenderLogin($Scene) {
    DefaultLeft $Scene 780
    if(([string]$Scene.id) -match 'register' -or ([string]$Scene.title) -match '注册') {
        BrowserFrame 950 358 880 526 '登录页 → 手机号注册'
        Txt '手机号注册 · 创建本人档案' 1000 443 775 52 34 $script:White $true
        Field '姓名' '演示人员 A' 1000 518 350
        Field '手机号' '请输入 11 位手机号' 1400 518 350
        Field '设置密码' '至少 8 位' 1000 641 350
        Field '确认密码' '再次输入相同密码' 1400 641 350
        Box 1000 778 750 60 $script:Accent '' 13
        Txt '注册并创建资料' 1020 790 710 39 28 $script:Bg $true 'Center'
        Txt '人员性质、属性、工作属性、部门、状态、楼栋可稍后补充' 1000 850 750 32 21 $script:Muted
        return
    }
    BrowserFrame 950 358 880 516 '登录页 · 手机号登录 / 注册'
    Txt '欢迎使用人力资源管理系统' 1010 450 755 57 34 $script:White $true
    Tag '手机号登录' 1010 518 194
    Txt '手机号注册' 1250 525 230 39 26 $script:Muted
    Field '手机号' '请输入 11 位手机号' 1010 588 350
    Field '密码' '••••••••' 1400 588 350
    Box 1010 728 740 62 $script:Accent '' 13
    Txt '登 录' 1030 741 700 39 29 $script:Bg $true 'Center'
    Txt '验证码按短信服务配置启用' 1010 815 744 38 23 $script:Muted
}
function RenderProfile($Scene) {
    DefaultLeft $Scene 770
    BrowserFrame 930 358 900 525 '我的资料 · 仅维护本人的档案'
    $fields=if($Scene.fields){@($Scene.fields)}else{@(
        @{label='姓名';value='演示人员 A'},@{label='工号（选填）';value='DEMO001'},
        @{label='部门（选填）';value='按实际归属选择'},@{label='楼栋（选填）';value='演示楼栋 A'},
        @{label='邮箱';value='按本人资料填写'},@{label='入职日期';value='按实际日期填写'}
    )}
    for($i=0;$i -lt [Math]::Min(6,$fields.Count);$i++){
        $cx=980+($i%2)*405;$cy=445+[Math]::Floor($i/2)*127
        Field ([string]$fields[$i].label) ([string]$fields[$i].value) $cx $cy 360
    }
    Tag '保存后等待服务端确认' 1080 836 390
}
function RenderPersonnel($Scene) {
    $cols=@('工号','姓名','部门','楼栋','邮箱','入职日期')
    $values=@('DEMO001','演示人员 A','演示部门','演示楼栋 A','本人邮箱','实际日期')
    $widths=@(250,270,260,300,350,240)
    BrowserFrame 80 360 1760 342 '人力资源 → 添加人员 / 人员列表'
    $xx=114
    for($i=0;$i -lt $cols.Count;$i++){
        Txt $cols[$i] $xx 460 ($widths[$i]-20) 45 27 $script:Accent $true
        Txt $values[$i] $xx 540 ($widths[$i]-20) 62 28 $script:White
        $xx+=$widths[$i]
    }
    Ln 114 513 1805 513 $script:Line 2
    Tag '+ 添加人员' 1475 622 300
    Bullets $Scene.bullets 100 750 1715 134 31
}
function RenderLeaders($Scene) {
    DefaultLeft $Scene 770
    Box 950 358 880 525 $script:Panel $script:Line 26
    Txt '设施运维主管 → 楼长授权' 990 395 795 61 36 $script:White $true
    $labels=if($Scene.steps){@($Scene.steps)}else{@('手机号注册','管理员分配角色与楼栋','看板自动同步姓名')}
    $stepCount=[Math]::Min(4,$labels.Count)
    $stepSlot=if($stepCount -gt 3){76}else{105}
    for($i=0;$i -lt $stepCount;$i++){
        $yy=485+$i*$stepSlot
        Dot 1013 ($yy+18) 19 $script:Accent
        Txt ([string]($i+1)) 999 ($yy-1) 28 39 24 $script:Bg $true 'Center'
        Txt $labels[$i] 1053 ($yy-2) 706 49 31 $script:White $true
        if($i -lt ($stepCount-1)){Ln 1013 ($yy+40) 1013 ($yy+$stepSlot-22) '#3A766D' 3}
    }
    Box 1010 791 760 61 '#193C46' '#2D7166' 16
    Txt '换人：撤销旧授权，再分配新楼长' 1035 806 710 39 27 $script:Accent $true
}
function RenderAttendance($Scene) {
    DefaultLeft $Scene 760
    BrowserFrame 930 358 900 525 '考勤管理 · 申请与处理'
    $steps=if($Scene.steps){@($Scene.steps)}else{@('选择加班申请或请假申请','填写日期、时段与说明','提交后查看申请状态','有权限的管理人员审批')}
    for($i=0;$i -lt [Math]::Min(4,$steps.Count);$i++){
        $yy=450+$i*91
        Box 980 $yy 800 72 '#17334B' '#2A4B63' 15
        Txt ('0'+($i+1)) 1000 ($yy+17) 69 41 27 $script:Accent $true
        Txt ([string]$steps[$i]) 1085 ($yy+16) 663 45 28 $script:White
    }
}
function RenderHours($Scene) {
    DefaultLeft $Scene 740
    Box 930 358 900 525 $script:Panel $script:Line 26
    Txt '我的小时数' 980 406 805 68 39 $script:White $true
    $cards=if($Scene.cards){@($Scene.cards)}else{@(
        @{title='费用加班';items=@('按已批准记录统计')},@{title='调休加班';items=@('累计可用调休来源')},
        @{title='已用调休';items=@('记录已使用的小时')},@{title='剩余调休';items=@('用于核对余额')}
    )}
    for($i=0;$i -lt [Math]::Min(4,$cards.Count);$i++){
        if($cards.Count -eq 3){
            $cx=980+$i*270;$cy=520
            Box $cx $cy 240 254 '#15374B' '#2C5366' 20
            Txt ([string]$cards[$i].title) ($cx+22) ($cy+27) 196 85 31 $script:Accent $true
            Txt ([string](@($cards[$i].items)[0])) ($cx+22) ($cy+130) 196 94 26 $script:Muted
        } else {
            $cx=980+($i%2)*405;$cy=505+[Math]::Floor($i/2)*159
            Box $cx $cy 365 131 '#15374B' '#2C5366' 20
            Txt ([string]$cards[$i].title) ($cx+22) ($cy+18) 320 43 30 $script:Accent $true
            Txt ([string](@($cards[$i].items)[0])) ($cx+22) ($cy+73) 320 43 23 $script:Muted
        }
    }
}
function RenderArchitecture($Scene) {
    $nodes=GetNodes $Scene @(
        @{title='浏览器';body='HTML / CSS / JavaScript'},@{title='Nginx';body='公网入口 / 反向代理'},
        @{title='Node.js';body='认证 / 权限 / 业务 API'},@{title='MySQL + JSON';body='业务快照 / 受保护配置'}
    )
    $n=[Math]::Min(4,$nodes.Count);$cw=385;$gap=70;$xx=80
    for($i=0;$i -lt $n;$i++){
        $xx=80+$i*455
        Box $xx 413 $cw 219 $script:Panel '#35576E' 25
        Txt ('0'+($i+1)) ($xx+25) 438 322 39 25 $script:Accent $true
        Txt ([string]$nodes[$i].title) ($xx+23) 492 339 53 36 $script:White $true 'Center'
        Txt ([string]$nodes[$i].body) ($xx+24) 565 337 52 23 $script:Muted $false 'Center'
        if($i -lt ($n-1)){Arrow ($xx+$cw+8) 523 ($xx+$cw+$gap-12) 523}
    }
    Box 95 690 1730 190 '#143540' '#285A61' 20
    Bullets $Scene.bullets 132 716 1650 150 30
}
function RenderStack($Scene) {
    if($Scene.cards) {
        $nodes=@($Scene.cards | ForEach-Object { @{title=[string]$_.title;body=(@($_.items)-join '  ·  ')} })
    } else { $nodes=GetNodes $Scene @(
        @{title='前端界面';body='HTML5 · CSS3 · 原生 JavaScript · Fetch'},
        @{title='服务端';body='Node.js · 内置 http / fs / crypto · mysql2'},
        @{title='数据与表格';body='MySQL 业务快照 · JSON 配置 · SheetJS'},
        @{title='部署运维';body='Ubuntu · Nginx · systemd · 阿里云 ECS'}
    ) }
    for($i=0;$i -lt [Math]::Min(4,$nodes.Count);$i++){
        $yy=360+$i*121
        Box 80 $yy 1760 104 $script:Panel $script:Line 18
        Box 96 ($yy+12) 303 80 '#1A414D' '' 13
        Txt ([string]$nodes[$i].title) 120 ($yy+33) 255 49 29 $script:Accent $true
        Txt ([string]$nodes[$i].body) 438 ($yy+30) 1349 58 32 $script:White
    }
    if($nodes.Count -le 3) { Bullets $Scene.bullets 100 767 1715 110 30 }
}
function RenderDevelopment($Scene) {
    DefaultLeft $Scene 700
    Box 850 358 980 525 '#081827' '#31516A' 24
    Dot 884 392 6 '#ED9587';Dot 907 392 6 '#E5C186';Dot 930 392 6 $script:Accent
    Txt 'PROJECT / 本地开发与校验' 966 374 812 40 23 $script:Muted
    Ln 874 424 1807 424 '#213B51' 1
    $lines=if($Scene.code){@($Scene.code)}else{@('node server/server.js','','node --test tests/*.test.js','','node scripts/generate-architecture.cjs','node scripts/generate-architecture.cjs --check')}
    $lineH=[Math]::Min(59,[Math]::Floor(375/[Math]::Max(1,$lines.Count)))
    for($i=0;$i -lt $lines.Count;$i++){
        $yy=452+$i*$lineH
        Txt ('{0:00}' -f ($i+1)) 879 $yy 57 $lineH 24 '#527087' $false 'Far' $true
        $lineColor=if(([string]$lines[$i]).StartsWith('#')){$script:Muted}else{$script:Accent}
        Txt ([string]$lines[$i]) 961 $yy 824 $lineH 28 $lineColor $false 'Near' $true
    }
}
function RenderDeployment($Scene) {
    $steps=if($Scene.steps){@($Scene.steps)}else{@('备份代码、配置与业务数据','校对固定版本与发布文件','安装代码并启动服务','核对登录、静态资源和权限','失败时回退已备份代码')}
    $n=[Math]::Min(5,$steps.Count)
    for($i=0;$i -lt $n;$i++){
        $xx=80+$i*358
        Box $xx 389 329 274 $script:Panel '#31516A' 22
        Tag ('STEP '+($i+1)) ($xx+28) 421 170
        Txt ([string]$steps[$i]) ($xx+27) 506 274 117 33 $script:White $true
        if($i -lt ($n-1)){Arrow ($xx+335) 525 ($xx+353) 525}
    }
    Box 80 695 1760 185 '#173541' '#35615F' 20
    Bullets $Scene.bullets 118 717 1675 155 30
}
function RenderOperations($Scene) {
    $cards=if($Scene.cards){@($Scene.cards)}else{@(
        @{title='应用服务';items=@('systemd 管理启动和重启','Nginx 提供统一访问入口')},
        @{title='数据保护';items=@('账号、配置与业务快照分别备份','发布时保留生产数据')},
        @{title='上线验收';items=@('检查服务状态及登录边界','核对静态资源与角色范围')}
    )}
    for($i=0;$i -lt [Math]::Min(3,$cards.Count);$i++){
        $xx=80+$i*594
        Box $xx 365 570 488 $script:Panel $script:Line 26
        Txt ('0'+($i+1)) ($xx+33) 399 500 46 28 $script:Accent $true
        Txt ([string]$cards[$i].title) ($xx+32) 464 503 68 41 $script:White $true
        Ln ($xx+32) 548 ($xx+536) 548 $script:Line
        Bullets $cards[$i].items ($xx+33) 585 500 232 31
    }
}
function RenderEnding($Scene) {
    Box 80 365 760 488 '#153940' '#387168' 28
    Txt '人员资料有人维护' 130 424 665 74 45 $script:Accent $true
    Txt '楼栋权限清晰分配' 130 524 665 74 45 $script:White $true
    Txt '更新发布有据可查' 130 624 665 74 45 $script:White $true
    Tag '使用操作 / 技术架构 / 部署运维' 130 749 650
    Bullets $Scene.bullets 930 397 866 430 35
}

$assets=@()
for($sceneIndex=0;$sceneIndex -lt $story.scenes.Count;$sceneIndex++) {
    $scene=$story.scenes[$sceneIndex]
    $bitmap=[Drawing.Bitmap]::new($script:W,$script:H,[Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $script:g=[Drawing.Graphics]::FromImage($bitmap)
    $script:g.SmoothingMode=[Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $script:g.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $script:g.TextRenderingHint=[Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    Header $scene ($sceneIndex+1) $story.scenes.Count
    switch([string]$scene.kind) {
        'cover' { RenderCover $scene }
        'roles' { RenderRoles $scene }
        'login' { RenderLogin $scene }
        'profile' { RenderProfile $scene }
        'personnel' { RenderPersonnel $scene }
        'leaders' { RenderLeaders $scene }
        'attendance' { RenderAttendance $scene }
        'hours' { RenderHours $scene }
        'architecture' { RenderArchitecture $scene }
        'stack' { RenderStack $scene }
        'development' { RenderDevelopment $scene }
        'deployment' { RenderDeployment $scene }
        'operations' { if($scene.code){RenderDevelopment $scene}else{RenderOperations $scene} }
        'ending' { RenderEnding $scene }
        default { RenderCover $scene }
    }
    $fileName=('scene-{0:000}.png' -f ($sceneIndex+1))
    $assetPath=[IO.Path]::GetFullPath((Join-Path $OutputDir $fileName))
    $bitmap.Save($assetPath,[Drawing.Imaging.ImageFormat]::Png)
    $script:g.Dispose()
    $bitmap.Dispose()
    $assets+=@{index=$sceneIndex+1;id=[string]$scene.id;kind=[string]$scene.kind;path=$assetPath;file=$fileName}
}

$cols=6
$rows=[Math]::Ceiling($assets.Count/$cols)
$thumbWidth=384
$thumbHeight=216
$labelHeight=46
$contact=[Drawing.Bitmap]::new(($cols*$thumbWidth),([int]$rows*($thumbHeight+$labelHeight)),[Drawing.Imaging.PixelFormat]::Format24bppRgb)
$cg=[Drawing.Graphics]::FromImage($contact)
$cg.Clear((Col '#071426'))
$cg.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$labelFont=Fnt 16
$labelBrush=Brush $script:White
for($i=0;$i -lt $assets.Count;$i++){
    $xx=($i%$cols)*$thumbWidth
    $yy=[Math]::Floor($i/$cols)*($thumbHeight+$labelHeight)
    $im=[Drawing.Image]::FromFile($assets[$i].path)
    $cg.DrawImage($im,[Drawing.Rectangle]::new($xx,$yy,$thumbWidth,$thumbHeight))
    $im.Dispose()
    $label=('{0:00}  {1}' -f ($i+1),[string]$story.scenes[$i].title)
    $cg.DrawString($label,$labelFont,$labelBrush,[Drawing.RectangleF]::new(($xx+12),($yy+$thumbHeight+6),($thumbWidth-24),($labelHeight-6)))
}
$contact.Save([IO.Path]::GetFullPath($ContactSheetPath),[Drawing.Imaging.ImageFormat]::Png)
$labelBrush.Dispose();$cg.Dispose();$contact.Dispose()
$manifest=@{width=$script:W;height=$script:H;safeSubtitleTop=956;count=$assets.Count;scenes=$assets;contactSheet=[IO.Path]::GetFullPath($ContactSheetPath)}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDir 'assets.json') -Encoding UTF8
foreach($font in $script:FontCache.Values){$font.Dispose()}
Write-Output ('Rendered {0} scenes at {1}x{2}.' -f $assets.Count,$script:W,$script:H)
Write-Output ([IO.Path]::GetFullPath($ContactSheetPath))
