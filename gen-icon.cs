using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

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
