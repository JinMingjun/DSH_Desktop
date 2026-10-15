# build-ico.ps1 - build a multi-size rounded-corner ICO with embedded PNG payloads.
# Pipeline: decode source -> square crop -> rounded corners (4x supersampled) -> PNG per size -> ICO container.
# Only .NET GDI+ is used (no Pillow / ImageMagick).
#
# Run:
#   powershell -File build-ico.ps1 -Source <img> -Out <out.ico> [-Preview <prev.png>]
#              [-CornerPercent 22.5] [-Zoom 0.68] [-VerticalBias -0.22]
#
# Zoom < 1 shrinks the crop window (magnifies the subject) so an edge caption band
# can be pushed out of frame. VerticalBias shifts the window centre down by
# bias * side; negative values move it up.
#
# IMPORTANT: PowerShell 5.1 parses .ps1 as ANSI unless the file carries a UTF-8 BOM,
# and PowerShell's [byte[]] cast on an Object[] can silently insert elements, which
# corrupts binary payloads. This script therefore writes through MemoryStream API
# methods with explicit (array, offset, count) arguments only.

param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Out,
  [string]$Preview,
  [double]$CornerPercent = 22.5,
  [double]$Zoom          = 0.68,
  [double]$VerticalBias  = -0.22
)

Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Text;

public static class IcoBuilder
{
    // Encode a bitmap as PNG bytes via an explicit stream write.
    // (A PowerShell [byte[]] cast here would prepend stray bytes and corrupt the chunk.)
    public static byte[] EncodePng(Bitmap bmp)
    {
        using (MemoryStream ms = new MemoryStream())
        {
            bmp.Save(ms, ImageFormat.Png);
            return ms.ToArray();
        }
    }

    // One icon size: draw the master into a 4x supersampled rounded-square clip, then downscale.
    public static Bitmap Render(Bitmap master, int size, double cornerPercent)
    {
        int ss = 4;
        int big = size * ss;
        Bitmap outBmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Bitmap baseBmp = new Bitmap(big, big, PixelFormat.Format32bppArgb))
        {
            using (Graphics gb = Graphics.FromImage(baseBmp))
            {
                gb.Clear(Color.Transparent);
                gb.SmoothingMode = SmoothingMode.AntiAlias;
                gb.InterpolationMode = InterpolationMode.HighQualityBicubic;
                gb.PixelOffsetMode = PixelOffsetMode.HighQuality;
                float r = (float)(big * cornerPercent / 100.0);
                float w = big;
                using (GraphicsPath path = new GraphicsPath())
                {
                    path.AddArc(0f, 0f, r * 2f, r * 2f, 180f, 90f);
                    path.AddArc(w - r * 2f, 0f, r * 2f, r * 2f, 270f, 90f);
                    path.AddArc(w - r * 2f, w - r * 2f, r * 2f, r * 2f, 0f, 90f);
                    path.AddArc(0f, w - r * 2f, r * 2f, r * 2f, 90f, 90f);
                    path.CloseFigure();
                    gb.SetClip(path);
                    gb.DrawImage(master, new Rectangle(0, 0, big, big));
                }
            }
            using (Graphics go = Graphics.FromImage(outBmp))
            {
                go.InterpolationMode = InterpolationMode.HighQualityBicubic;
                go.PixelOffsetMode = PixelOffsetMode.HighQuality;
                go.DrawImage(baseBmp, new Rectangle(0, 0, size, size));
            }
        }
        return outBmp;
    }

    // ICO container: ICONDIR + ICONDIRENTRY[n] + payloads, all sizes as PNG entries.
    public static void Write(string outPath, Bitmap master, int[] sizes, double cornerPercent)
    {
        List<KeyValuePair<int, byte[]>> items = new List<KeyValuePair<int, byte[]>>();
        foreach (int s in sizes)
        {
            using (Bitmap b = Render(master, s, cornerPercent))
                items.Add(new KeyValuePair<int, byte[]>(s, EncodePng(b)));
        }

        string dir = Path.GetDirectoryName(outPath);
        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);

        using (FileStream fs = new FileStream(outPath, FileMode.Create, FileAccess.Write))
        using (BinaryWriter bw = new BinaryWriter(fs))
        {
            bw.Write((ushort)0);            // reserved
            bw.Write((ushort)1);            // type: icon
            bw.Write((ushort)items.Count);
            int offset = 6 + 16 * items.Count;
            foreach (KeyValuePair<int, byte[]> it in items)
            {
                byte dim = (byte)(it.Key >= 256 ? 0 : it.Key);
                bw.Write(dim);              // width  (0 means 256)
                bw.Write(dim);              // height (0 means 256)
                bw.Write((byte)0);          // palette count
                bw.Write((byte)0);          // reserved
                bw.Write((ushort)1);        // colour planes
                bw.Write((ushort)32);       // bits per pixel
                bw.Write((uint)it.Value.Length);
                bw.Write((uint)offset);
                offset += it.Value.Length;
            }
            foreach (KeyValuePair<int, byte[]> it in items)
                bw.Write(it.Value, 0, it.Value.Length);
        }
    }

    // Preview sheet: left = crop, right = 256px icon plus real pixel sizes on a checkerboard.
    public static void Preview(string path, Bitmap crop, double cornerPercent)
    {
        int W = 660, H = 340;
        using (Bitmap prev = new Bitmap(W, H, PixelFormat.Format32bppArgb))
        {
            using (Graphics gp = Graphics.FromImage(prev))
            {
                gp.Clear(Color.FromArgb(255, 44, 46, 58));
                using (SolidBrush c1 = new SolidBrush(Color.FromArgb(255, 60, 62, 76)))
                using (SolidBrush c2 = new SolidBrush(Color.FromArgb(255, 50, 52, 64)))
                    for (int yy = 0; yy < H; yy += 16)
                        for (int xx = 300; xx < W; xx += 16)
                            gp.FillRectangle(((xx / 16) + (yy / 16)) % 2 == 0 ? c1 : c2, xx, yy, 16, 16);
                gp.InterpolationMode = InterpolationMode.HighQualityBicubic;
                gp.DrawImage(crop, new Rectangle(10, 10, 300, 300));
                using (Pen pen = new Pen(Color.Gray, 1)) gp.DrawRectangle(pen, 10, 10, 300, 300);
                gp.InterpolationMode = InterpolationMode.NearestNeighbor;
                using (Bitmap b256 = Render(crop, 256, cornerPercent))
                    gp.DrawImage(b256, new Rectangle(320, 10, 256, 256));
                int x = 320, y = 284;
                foreach (int s in new int[] { 64, 48, 32, 24, 16 })
                {
                    using (Bitmap b = Render(crop, s, cornerPercent))
                        gp.DrawImage(b, new Rectangle(x, y, s, s));
                    x += s + 8;
                }
            }
            prev.Save(path, ImageFormat.Png);
        }
    }

    // Square crop window; Zoom shrinks it, VerticalBias shifts its centre down.
    public static Bitmap Crop(Image src, double zoom, double verticalBias)
    {
        int sw = src.Width, sh = src.Height;
        int full = Math.Min(sw, sh);
        int side = (int)(full * zoom);
        if (side < 8) side = 8;
        if (side > full) side = full;
        int left = (sw - side) / 2;
        int top = (int)((sh - side) / 2.0 + side * verticalBias);
        if (top < 0) top = 0;
        if (top + side > sh) top = sh - side;

        Bitmap crop = new Bitmap(side, side, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(crop))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.DrawImage(src, new Rectangle(0, 0, side, side), new Rectangle(left, top, side, side), GraphicsUnit.Pixel);
        }
        return crop;
    }
}
'@

# Read the source through memory so GDI+ never keeps a lock on the file.
$bytes = [System.IO.File]::ReadAllBytes($Source)
$ms    = New-Object System.IO.MemoryStream
$ms.Write($bytes, 0, $bytes.Length)
$ms.Position = 0
$src = [System.Drawing.Image]::FromStream($ms)

$crop = [IcoBuilder]::Crop($src, $Zoom, $VerticalBias)
$src.Dispose(); $ms.Dispose()

$sizes = @(256, 128, 64, 48, 40, 32, 24, 20, 16)
[IcoBuilder]::Write($Out, $crop, $sizes, $CornerPercent)
if ($Preview) { [IcoBuilder]::Preview($Preview, $crop, $CornerPercent) }

$cropW = $crop.Width
$crop.Dispose()

$kb = [Math]::Round((Get-Item $Out).Length / 1024, 1)
"OK -> $Out ($kb KB); sizes=$($sizes -join ','); cropSide=$cropW"
