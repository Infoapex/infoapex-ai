using AiCodeControl.Memory.Services;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class MemorySearchTests
{
    [Fact]
    public void BuildFtsQuery_UsesOrSemantics_AndDropsStopWords()
    {
        var query = MemorySearchService.BuildFtsQuery("Implement the checkout flow for orders");

        Assert.Contains(" OR ", query);
        Assert.Contains("\"checkout\"", query);
        Assert.Contains("\"orders\"", query);
        Assert.DoesNotContain("\"the\"", query);
        Assert.DoesNotContain("\"for\"", query);
    }

    [Fact]
    public void BuildFtsQuery_FallsBackWhenEverythingIsStopWords()
    {
        var query = MemorySearchService.BuildFtsQuery("the of");
        Assert.False(string.IsNullOrWhiteSpace(query));
    }

    [Fact]
    public void BuildFtsQuery_EscapesQuotesAndPunctuation()
    {
        var query = MemorySearchService.BuildFtsQuery("fix \"quoted\" term (with parens)");
        Assert.Contains("\"quoted\"", query);
        Assert.DoesNotContain("(", query);
    }
}
