using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Collections.Generic;
using System.Web.Script.Serialization;

class GenIcon
{
    static readonly int[] Sizes = new int[] { 16, 24, 32, 48, 64, 128, 256 };

    static void Main()
    {
        string sourcePath = Path.Combine("icon", "icon.png");
        string roundedPath = Path.Combine("icon", "icon-rounded.png");
        string outputPath = Path.Combine("icon", "tray-icon.ico");
        if (!File.Exists(sourcePath))
        {
            Console.Error.WriteLine("Missing icon source: " + sourcePath);
            Environment.Exit(1);
        }

        try
        {
            byte[][] images = new byte[Sizes.Length][];
            using (Bitmap source = new Bitmap(sourcePath))
            {
                File.WriteAllBytes(roundedPath, RenderPng(source, 256));
                for (int i = 0; i < Sizes.Length; i++) images[i] = RenderPng(source, Sizes[i]);
                RenderInstallerArtwork(source);
            }

            using (FileStream stream = new FileStream(outputPath, FileMode.Create, FileAccess.Write))
            using (BinaryWriter writer = new BinaryWriter(stream))
            {
                writer.Write((ushort)0);
                writer.Write((ushort)1);
                writer.Write((ushort)Sizes.Length);

                int offset = 6 + Sizes.Length * 16;
                for (int i = 0; i < Sizes.Length; i++)
                {
                    writer.Write((byte)(Sizes[i] == 256 ? 0 : Sizes[i]));
                    writer.Write((byte)(Sizes[i] == 256 ? 0 : Sizes[i]));
                    writer.Write((byte)0);
                    writer.Write((byte)0);
                    writer.Write((ushort)1);
                    writer.Write((ushort)32);
                    writer.Write((uint)images[i].Length);
                    writer.Write((uint)offset);
                    offset += images[i].Length;
                }

                for (int i = 0; i < images.Length; i++) writer.Write(images[i]);
            }
            Console.WriteLine(roundedPath + " generated with transparent rounded corners");
            Console.WriteLine(outputPath + " generated with " + Sizes.Length + " sizes");
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Icon generation failed: " + error.Message);
            Environment.Exit(1);
        }
    }

    static void RenderInstallerArtwork(Bitmap source)
    {
        var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText("windows-build.json"));
        var ui = (Dictionary<string, object>)config["installer_ui"];
        string output = Path.Combine(".build", "windows");
        Directory.CreateDirectory(output);
        RenderInstallerBitmap(source, Path.Combine(output, "installer-welcome.bmp"),
            Convert.ToInt32(ui["welcome_width"]), Convert.ToInt32(ui["welcome_height"]),
            Convert.ToInt32(ui["welcome_logo_size"]), ColorTranslator.FromHtml((string)ui["background_color"]));
        RenderInstallerBitmap(source, Path.Combine(output, "installer-welcome-dark.bmp"),
            Convert.ToInt32(ui["welcome_width"]), Convert.ToInt32(ui["welcome_height"]),
            Convert.ToInt32(ui["welcome_logo_size"]), ColorTranslator.FromHtml((string)ui["background_dark_color"]));
        int headerSize = Convert.ToInt32(ui["header_size"]);
        RenderInstallerBitmap(source, Path.Combine(output, "installer-logo.bmp"),
            headerSize, headerSize, Convert.ToInt32(ui["header_logo_size"]), ColorTranslator.FromHtml((string)ui["header_color"]));
        RenderInstallerBitmap(source, Path.Combine(output, "installer-logo-dark.bmp"),
            headerSize, headerSize, Convert.ToInt32(ui["header_logo_size"]), ColorTranslator.FromHtml((string)ui["header_dark_color"]));
        Console.WriteLine("Installer artwork generated from the application icon");
    }

    static void RenderInstallerBitmap(Bitmap source, string output, int width, int height, int logoSize, Color background)
    {
        using (Bitmap canvas = new Bitmap(width, height, PixelFormat.Format24bppRgb))
        using (Graphics graphics = Graphics.FromImage(canvas))
        using (MemoryStream memory = new MemoryStream(RenderPng(source, logoSize)))
        using (Bitmap logo = new Bitmap(memory))
        {
            graphics.Clear(background);
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.SmoothingMode = SmoothingMode.HighQuality;
            graphics.DrawImage(logo, (width - logoSize) / 2, (height - logoSize) / 2, logoSize, logoSize);
            canvas.Save(output, ImageFormat.Bmp);
        }
    }

    static byte[] RenderPng(Bitmap source, int size)
    {
        int scale = 4;
        int canvasSize = size * scale;
        using (Bitmap canvas = new Bitmap(canvasSize, canvasSize, PixelFormat.Format32bppArgb))
        using (Graphics graphics = Graphics.FromImage(canvas))
        using (GraphicsPath clip = RoundedRectangle(new RectangleF(0, 0, canvasSize, canvasSize), canvasSize * 0.22f))
        using (Bitmap target = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        using (Graphics targetGraphics = Graphics.FromImage(target))
        using (MemoryStream memory = new MemoryStream())
        {
            graphics.Clear(Color.Transparent);
            graphics.CompositingMode = CompositingMode.SourceOver;
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.SmoothingMode = SmoothingMode.HighQuality;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.SetClip(clip);
            graphics.DrawImage(source, new Rectangle(0, 0, canvasSize, canvasSize));

            targetGraphics.Clear(Color.Transparent);
            targetGraphics.CompositingMode = CompositingMode.SourceCopy;
            targetGraphics.CompositingQuality = CompositingQuality.HighQuality;
            targetGraphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            targetGraphics.SmoothingMode = SmoothingMode.HighQuality;
            targetGraphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            targetGraphics.DrawImage(canvas, new Rectangle(0, 0, size, size));
            target.Save(memory, ImageFormat.Png);
            return memory.ToArray();
        }
    }

    static GraphicsPath RoundedRectangle(RectangleF rectangle, float radius)
    {
        float diameter = radius * 2;
        GraphicsPath path = new GraphicsPath();
        path.AddArc(rectangle.Left, rectangle.Top, diameter, diameter, 180, 90);
        path.AddArc(rectangle.Right - diameter, rectangle.Top, diameter, diameter, 270, 90);
        path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(rectangle.Left, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }
}
